"use strict";

// ========== 飞书机器人异常通知 ==========
// 目标：应用"被自动重启"时通过自定义机器人 webhook 推送告警，未配置则完全不发送。
//
// 通知场景（精确界定）：
//   A. 看门狗 OOM 自动重启（print.js watchdog 内存超限 → app.relaunch + app.exit）
//      → 退出前直接发送（notifyOOMRestart，等待发送完成或超时后再重启）
//   B. 崩溃/被杀后保活计划任务拉起、断电重启后开机自启拉起
//      → 无法在崩溃前拦截（原生崩溃连 JS 都执行不到），采用"运行标记"检测：
//        启动时写 running.marker；优雅退出（before-quit）删除；
//        新实例启动时标记仍存在 = 上次非正常退出 → 通知（checkStartupCrash）
//   C. 用户主动退出 → before-quit 清标记，不通知
//
// 崩溃循环防护：2026-09-16/17 日志实测崩溃风暴中保活每分钟拉起一次（5~9 连崩），
// 若每次都通知会刷屏。10 分钟节流窗口 + 抑制计数，下次成功发送时附带"N 次被抑制"。
//
// app.exit() 不触发 before-quit，因此 OOM 路径的标记清理在 notifyOOMRestart 内部
// 按发送结果处理：发送成功（已通知）→ 清标记；失败/被节流 → 保留标记，
// 由重启后的 checkStartupCrash 兜底再通知。

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const { app, ipcMain, BrowserWindow } = require("electron");
const helper = require("./helper");
const { logInfo, logError, getConfig, saveConfig } = helper;
const address = require("address");

// 配置键：飞书自定义机器人 webhook 地址
const CONFIG_KEY = "feishuWebhook";
// 运行标记文件（脏标记：存在 = 上次实例非正常退出）
const MARKER_FILE = "running.marker";
// 节流状态文件
const STATE_FILE = "feishu-notify.state.json";
// 同类告警节流窗口（毫秒）：崩溃循环时不刷屏
const THROTTLE_MS = 10 * 60 * 1000;
// 单次 HTTP 发送超时（毫秒）：OOM 退出前等待上限
const SEND_TIMEOUT_MS = 6000;
// 启动崩溃通知延迟（毫秒）：给网络栈/日志系统一点就绪时间
const STARTUP_NOTIFY_DELAY_MS = 5000;

function getUserDataDir() {
  return app.getPath("userData");
}
function getMarkerPath() {
  return path.join(getUserDataDir(), MARKER_FILE);
}
function getStatePath() {
  return path.join(getUserDataDir(), STATE_FILE);
}

/**
 * yyyy-mm-dd HH:mm:ss 本地时间
 */
function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function getWebhook() {
  const url = String(getConfig(CONFIG_KEY, "") || "").trim();
  // 基本合法性：飞书自定义机器人 webhook
  return /^https?:\/\/.+/i.test(url) ? url : "";
}

/**
 * POST JSON 到飞书 webhook
 * @param {string} url - webhook 地址
 * @param {Object} payload - 完整请求体（msg_type=interactive 的消息卡片）
 * @returns {Promise<void>} 非 0 响应码 reject
 */
function postWebhook(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error("webhook 地址无效"));
    }
    const mod = u.protocol === "https:" ? https : http;
    const body = Buffer.from(JSON.stringify(payload), "utf-8");
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": body.length },
        timeout: timeoutMs,
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => {
          buf += c;
          if (buf.length > 8192) req.destroy();
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
          }
          // 飞书成功响应 {"code":0} / 旧版 {"StatusCode":0}；非 0 为业务错误（如签名失效）
          try {
            const parsed = JSON.parse(buf);
            const code = parsed.code !== undefined ? parsed.code : parsed.StatusCode;
            if (code !== undefined && code !== 0) {
              return reject(new Error(parsed.msg || parsed.StatusMessage || `飞书返回 code=${code}`));
            }
          } catch (e) {
            /* 响应非 JSON（可能被网关拦截），HTTP 200 即视为送达 */
          }
          resolve();
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`请求超时(${timeoutMs}ms)`)));
    req.on("error", reject);
    req.end(body);
  });
}

// ========== 节流状态 ==========
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(getStatePath(), "utf-8"));
  } catch (e) {
    return { lastSentAt: 0, suppressed: 0 };
  }
}
function saveState(state) {
  try {
    fs.writeFileSync(getStatePath(), JSON.stringify(state), "utf-8");
  } catch (e) {
    logError("feishu-saveState", e);
  }
}

/**
 * 构造告警消息卡片（飞书 interactive card）
 * 模板：红色标题头 + 事件一句话 + 逐行 detail 字段（key: value 加粗 key）
 * 文档: https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
 * @returns {Object} 完整 webhook 请求体
 */
function buildCardPayload(eventLine, detailLines, suppressed, isTest) {
  const elements = [];
  if (detailLines && detailLines.length) {
    const fields = detailLines.map((l) => {
      // "key: value" 形式拆分为字段名与值；无冒号则整行作为 value
      const idx = l.indexOf(":");
      const isField = idx > 0 && idx < 30 && !/^http/i.test(l);
      const content = isField
        ? `**${l.slice(0, idx).trim()}**: ${l.slice(idx + 1).trim()}`
        : l;
      // fields[].text 必须是 lark_md tag 对象，纯字符串会被飞书拒绝
      // （ErrCode 200621 parse card json err: mismatched type with value string）
      return {
        is_short: false,
        text: { tag: "lark_md", content },
      };
    });
    elements.push({ tag: "div", fields });
  }
  if (suppressed > 0) {
    elements.push({
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: `近 10 分钟内另有 ${suppressed} 次同类告警被节流抑制`,
        },
      ],
    });
  }
  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: isTest ? "blue" : "red",
        title: {
          tag: "plain_text",
          content: isTest ? "hiprint 打印服务 · 通知配置测试" : "hiprint 打印服务异常告警",
        },
      },
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `**${eventLine}**`,
          },
        },
        { tag: "hr" },
        ...elements,
        {
          tag: "note",
          elements: [
            {
              tag: "plain_text",
              content: `主机 ${os.hostname()} · ${address.ip()} · v${app.getVersion()} · ${fmtTime(Date.now())}`,
            },
          ],
        },
      ],
    },
  };
}

/**
 * 发送自动重启类告警（带节流）。未配置 webhook 时直接跳过。
 * @returns {Promise<{sent: boolean}>}
 */
async function notifyAutoRestart(eventLine, detailLines) {
  const webhook = getWebhook();
  if (!webhook) {
    logInfo("feishu-notify", "未配置飞书 webhook，跳过通知");
    return { sent: false };
  }
  // 节流：崩溃循环（保活每分钟拉起）时不刷屏
  const state = loadState();
  if (Date.now() - (state.lastSentAt || 0) < THROTTLE_MS) {
    state.suppressed = (state.suppressed || 0) + 1;
    saveState(state);
    logInfo("feishu-notify", `节流窗口内（上次发送 ${fmtTime(state.lastSentAt)}），本次告警被抑制（累计 ${state.suppressed} 次）`);
    return { sent: false };
  }
  const payload = buildCardPayload(eventLine, detailLines, state.suppressed || 0, false);
  await postWebhook(webhook, payload, SEND_TIMEOUT_MS);
  saveState({ lastSentAt: Date.now(), suppressed: 0 });
  logInfo("feishu-notify", `告警已发送: ${eventLine}`);
  return { sent: true };
}

// ========== 场景 B：启动时脏标记检测 ==========

/**
 * 应用启动时调用（main.js whenReady）：
 * 1. 同步写运行标记（尽早写入，启动早期崩溃也能被下次检测到）
 * 2. 若上次实例的标记仍在（未走 before-quit 清理）→ 上次为异常退出，
 *    本次实例是被保活计划任务/开机自启拉起的 → 延迟发送告警
 * @param {boolean} hiddenLaunch - 启动参数含 --hidden（保活拉起/开机自启为 true）
 */
function checkStartupCrash(hiddenLaunch) {
  const markerPath = getMarkerPath();
  let prev = null;
  try {
    if (fs.existsSync(markerPath)) {
      prev = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
    }
  } catch (e) {
    logError("feishu-read-marker", e);
    prev = null;
  }

  // 无论是否检测到异常，都写入本实例的运行标记
  try {
    fs.writeFileSync(markerPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf-8");
  } catch (e) {
    logError("feishu-write-marker", e);
  }

  if (!prev) {
    logInfo("feishu-startup", "上次为正常退出（无脏标记），不发送通知");
    return;
  }

  const prevStart = prev.startedAt ? fmtTime(prev.startedAt) : "未知";
  const detail = [
    `上次启动: ${prevStart} (PID ${prev.pid || "未知"})`,
    `上次退出: 非正常退出（崩溃/被杀/断电，未走优雅退出路径）`,
    `本次拉起: ${hiddenLaunch ? "保活计划任务/开机自启（--hidden）" : "手动启动"}`,
    `日志目录: ${path.join(app.getPath("userData"), "logs")}`,
  ];
  logInfo("feishu-startup", `检测到上次实例异常退出（PID ${prev.pid}），${STARTUP_NOTIFY_DELAY_MS}ms 后发送通知`);
  // fire-and-forget：通知失败不影响应用启动
  setTimeout(() => {
    notifyAutoRestart("应用异常退出后已被自动拉起", detail).catch((err) => {
      logError("feishu-startup-notify", err);
    });
  }, STARTUP_NOTIFY_DELAY_MS);
}

/**
 * 优雅退出路径调用（before-quit）：删除运行标记
 * 崩溃路径不会走到这里 → 标记保留 → 下次启动检测到
 */
function clearRunningMarker() {
  try {
    if (fs.existsSync(getMarkerPath())) {
      fs.unlinkSync(getMarkerPath());
      logInfo("feishu-clear-marker", "优雅退出，已清除运行标记");
    }
  } catch (e) {
    logError("feishu-clear-marker", e);
  }
}

// ========== 场景 A：OOM 自动重启（退出前通知） ==========

/**
 * 看门狗 OOM 自动重启前调用（print.js）。
 * 必须在 app.relaunch/app.exit 之前 await 本函数：
 * - 发送成功 → 清运行标记（已通知，重启后不重复告警）
 * - 发送失败/被节流 → 保留标记，重启后由 checkStartupCrash 兜底通知
 * @returns {Promise<void>}
 */
async function notifyOOMRestart(memDesc) {
  const webhook = getWebhook();
  if (!webhook) {
    // 未配置：没有可发送的渠道，直接清标记避免残留脏状态
    clearRunningMarker();
    return;
  }
  try {
    await notifyAutoRestart("内存超限，应用即将自动重启（保活）", [
      `内存: ${memDesc}`,
      "未完成任务: 已持久化，重启后自动恢复",
    ]);
    clearRunningMarker();
  } catch (err) {
    logError("feishu-oom-notify", err);
    // 发送失败保留标记，重启后兜底通知
  }
}

// ========== 配置窗口（托盘菜单入口） ==========

let _configWin = null;
let _ipcReady = false;

function initIpc() {
  if (_ipcReady) return;
  _ipcReady = true;
  ipcMain.handle("feishu-config-get", () => getConfig(CONFIG_KEY, ""));
  ipcMain.handle("feishu-config-save", (event, url) => {
    const v = String(url || "").trim();
    if (v && !/^https?:\/\/.+/i.test(v)) {
      return { ok: false, msg: "地址需以 http(s):// 开头" };
    }
    saveConfig(CONFIG_KEY, v);
    logInfo("feishu-config", v ? "飞书 webhook 已配置" : "飞书 webhook 已清空");
    return { ok: true };
  });
  ipcMain.handle("feishu-test", async (event, url) => {
    const u = String(url || "").trim();
    if (!u) return { ok: false, msg: "请先填写 webhook 地址" };
    try {
      const payload = buildCardPayload("配置测试：收到本卡片说明 webhook 配置正确", null, 0, true);
      await postWebhook(u, payload, SEND_TIMEOUT_MS);
      return { ok: true };
    } catch (err) {
      return { ok: false, msg: err.message };
    }
  });
}

/**
 * 打开飞书通知配置窗口（托盘菜单调用）
 */
function openConfigWindow() {
  if (_configWin && !_configWin.isDestroyed()) {
    _configWin.focus();
    return;
  }
  initIpc();
  _configWin = new BrowserWindow({
    width: 560,
    height: 330,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "飞书异常通知设置",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
  });
  _configWin.loadURL("file://" + path.join(__dirname, "../assets/feishu-config.html"));
  _configWin.on("closed", () => {
    _configWin = null;
  });
}

module.exports = {
  checkStartupCrash,
  clearRunningMarker,
  notifyOOMRestart,
  openConfigWindow,
  // 供 print.js 孤儿窗口对账使用：返回配置窗口引用（可能为 null/已销毁）
  getConfigWindow: () => _configWin,
};
