/**
 * Electron 44 远程多场景测试脚本
 *
 * 用途：验证部署在测试服务器（如 WinServer 2019）上的 electron-hiprint v2.0.0
 *       在 Electron 44 / Chromium 152 下的完整链路兼容性
 *
 * 使用方法（在项目目录下运行，需能访问目标服务器 17521 端口）：
 *   node test-remote-e44.js                                    # 全部场景（会真实出纸，约 16 张小票）
 *   node test-remote-e44.js --skip-print                       # 只测通道，不出纸（S1/S2/S8/S9/S10）
 *   node test-remote-e44.js --url http://10.1.70.85:17521      # 指定地址（默认即此）
 *   node test-remote-e44.js --printer "Microsoft Print to PDF" # 指定打印机（默认用服务器默认打印机）
 *   node test-remote-e44.js --count 5                          # S6 并发任务数（默认 10）
 *
 * 场景覆盖：
 *   S1  连接握手 + printerList 推送（Chromium 152 下 socket 服务可用）
 *   S2  refreshPrinterList 主动刷新
 *   S3  news 单任务静默打印（HTML 直打）
 *   S4  多副本打印（copies=3）
 *   S5  无效打印机容错（应回退默认打印机而非崩溃——9/15 崩溃循环场景）
 *   S6  并发任务风暴（模拟断线重连后网页端补发，验证队列不丢任务）
 *   S7  news-server 模板渲染（hiprint.bundle 在 Chromium 152 下的渲染管线）
 *   S8  断开重连
 *   S9  非法数据容错（畸形报文不得杀掉连接/服务）
 *   S10 address 地址查询
 *
 * 判定：任一场景 FAIL 时进程退出码为 1，可用于 CI/计划任务。
 */

const { io } = require("socket.io-client");

// ========== 参数解析 ==========
const args = process.argv.slice(2);
function argValue(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
}
const SERVER_URL = argValue("url", "http://10.1.70.85:17521");
const PRINTER_ARG = argValue("printer", null);
const CONCURRENCY = parseInt(argValue("count", "10"), 10);
const SKIP_PRINT = args.includes("--skip-print");

// ========== 结果记录 ==========
const results = []; // { id, name, status: PASS|FAIL|SKIP|WARN, ms, detail }
function record(id, name, status, ms, detail) {
  results.push({ id, name, status, ms, detail });
  const tag = { PASS: "\x1b[32mPASS\x1b[0m", FAIL: "\x1b[31mFAIL\x1b[0m", SKIP: "\x1b[33mSKIP\x1b[0m", WARN: "\x1b[33mWARN\x1b[0m" }[status];
  console.log(`  [${tag}] ${id} ${name} (${ms}ms)${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let taskIdSeq = 0;
const nextTid = () => `e44test-${Date.now()}-${++taskIdSeq}`;

// ========== 通用工具 ==========
function receiptHtml(title, lines) {
  return (
    `<div style="width:220px;font-family:sans-serif;font-size:12px;color:#000;">` +
    `<div style="text-align:center;font-weight:bold;border-bottom:1px dashed #000;padding:4px 0;">${title}</div>` +
    lines.map((l) => `<div style="padding:2px 0;">${l}</div>`).join("") +
    `<div style="border-top:1px dashed #000;margin-top:4px;padding-top:4px;text-align:center;">Electron44 Server2019 测试 ${new Date().toLocaleTimeString()}</div>` +
    `</div>`
  );
}

/** 建立连接并等待首次 printerList（连接即推送） */
function connectAndHandshake(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { forceNew: true, timeout: timeoutMs, reconnection: false });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`连接/握手超时(${timeoutMs}ms)`));
    }, timeoutMs);
    socket.on("connect_error", (err) => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(`连接失败: ${err.message}`));
    });
    socket.on("connect", () => {
      // 已连上，等 printerList
    });
    socket.on("printerList", (printers) => {
      clearTimeout(timer);
      resolve({ socket, printers: printers || [] });
    });
  });
}

/** 发送一个打印任务并等待 success/error 回调（按 templateId 关联） */
function printOnce(socket, payload, timeoutMs) {
  return new Promise((resolve) => {
    const tid = payload.templateId;
    const t0 = Date.now();
    const finish = (status, msg) => {
      clearTimeout(timer);
      socket.off("success", onSuccess);
      socket.off("error", onError);
      resolve({ status, msg, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => finish("TIMEOUT", `等待打印回调超时(${timeoutMs}ms)`), timeoutMs);
    const onSuccess = (d) => d && d.templateId === tid && finish("SUCCESS", d.msg);
    const onError = (d) => d && d.templateId === tid && finish("ERROR", d.msg);
    socket.on("success", onSuccess);
    socket.on("error", onError);
    socket.emit(payload.__channel || "news", payload.__channel ? payload.__payload : payload);
  });
}

/** 等待单个事件（带超时） */
function waitEvent(socket, event, timeoutMs, filter) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`等待 ${event} 超时(${timeoutMs}ms)`));
    }, timeoutMs);
    const handler = (...args) => {
      if (filter && !filter(...args)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(args);
    };
    socket.on(event, handler);
  });
}

// ========== 各场景 ==========
async function s1_handshake() {
  const t0 = Date.now();
  const { socket, printers } = await connectAndHandshake(SERVER_URL);
  const def = printers.find((p) => p.isDefault);
  record("S1", "连接握手 + printerList 推送", "PASS", Date.now() - t0, `打印机 ${printers.length} 台，默认 "${def ? def.name : "无"}"`);
  return { socket, printers, defaultPrinter: def ? def.name : printers.length ? printers[0].name : null };
}

async function s2_refresh(socket) {
  const t0 = Date.now();
  socket.emit("refreshPrinterList");
  const [printers] = await waitEvent(socket, "printerList", 10000);
  record("S2", "refreshPrinterList 主动刷新", "PASS", Date.now() - t0, `打印机 ${printers.length} 台`);
}

async function s3_singlePrint(socket, printer) {
  const t0 = Date.now();
  const tid = nextTid();
  const r = await printOnce(socket, {
    templateId: tid,
    printer,
    html: receiptHtml("S3 单任务静默打印", ["链路: socket news → 队列 → print", `打印机: ${printer}`]),
    silent: true,
  }, 90000);
  const status = r.status === "SUCCESS" ? "PASS" : "FAIL";
  record("S3", "news 单任务静默打印", status, Date.now() - t0, `${r.status} ${r.msg || ""}`);
}

async function s4_copies(socket, printer) {
  const t0 = Date.now();
  const tid = nextTid();
  const r = await printOnce(socket, {
    templateId: tid,
    printer,
    html: receiptHtml("S4 多副本打印 copies=3", ["本小票应出 3 联"]),
    copies: 3,
    silent: true,
  }, 90000);
  const status = r.status === "SUCCESS" ? "PASS" : "FAIL";
  record("S4", "多副本打印 copies=3", status, Date.now() - t0, `${r.status} ${r.msg || ""}`);
}

async function s5_invalidPrinter(socket, printer) {
  const t0 = Date.now();
  const tid = nextTid();
  const r = await printOnce(socket, {
    templateId: tid,
    printer: "__不存在的打印机_E44TEST__",
    html: receiptHtml("S5 无效打印机容错", ["请求打印机不存在，应回退默认打印机", `默认: ${printer}`]),
    silent: true,
  }, 90000);
  // 预期：服务端回退默认打印机并打印成功；关键是进程不崩溃、连接不断
  const status = r.status === "SUCCESS" ? "PASS" : r.status === "ERROR" ? "WARN" : "FAIL";
  record("S5", "无效打印机容错（回退默认）", status, Date.now() - t0,
    r.status === "SUCCESS" ? "已回退默认打印机并成功" : `${r.status} ${r.msg || ""}`);
}

async function s6_storm(socket, printer) {
  const t0 = Date.now();
  const jobs = [];
  for (let i = 1; i <= CONCURRENCY; i++) {
    jobs.push(
      printOnce(socket, {
        templateId: nextTid(),
        printer,
        html: receiptHtml(`S6 并发风暴 ${i}/${CONCURRENCY}`, ["模拟断线重连后的任务补发"]),
        silent: true,
      }, CONCURRENCY * 60000)
    );
  }
  const rs = await Promise.all(jobs);
  const ok = rs.filter((r) => r.status === "SUCCESS").length;
  const err = rs.filter((r) => r.status === "ERROR").length;
  const slow = Math.max(...rs.map((r) => r.ms));
  const status = ok === CONCURRENCY ? "PASS" : ok > 0 ? "WARN" : "FAIL";
  record("S6", `并发风暴 x${CONCURRENCY}（队列不丢任务）`, status, Date.now() - t0,
    `成功 ${ok} / 失败 ${err}${err ? `：${rs.filter((r) => r.status === "ERROR").map((r) => r.msg).join("; ")}` : ""}，最慢单任务 ${slow}ms`);
}

/** 最小 hiprint 模板（与 test-news-server.js 同构） */
function hiprintTemplate(title) {
  return {
    panels: [{
      index: 0, height: 40, width: 60, paperNumberDisabled: true,
      printElements: [{
        tid: "e44test.text",
        options: { left: 5, top: 5, height: 30, width: 50, title, fontSize: 12, fontWeight: "bold", textAlign: "center" },
        printElementType: { title: "文本", type: "text" },
      }],
    }],
  };
}

async function s7_newsServer(socket, printer) {
  const t0 = Date.now();
  const tid = nextTid();
  const payload = {
    templateId: tid,
    printer,
    template: hiprintTemplate("S7 news-server 渲染"),
    data: [{}], // 一页，无字段绑定，渲染固定 title
  };
  // news-server 走"先持久化再渲染"路径，真实调用方发 JSON 字符串
  const r = await printOnce(socket, { __channel: "news-server", templateId: tid, __payload: JSON.stringify(payload) }, 90000);
  const status = r.status === "SUCCESS" ? "PASS" : "FAIL";
  record("S7", "news-server 模板渲染管线（hiprint/Chromium152）", status, Date.now() - t0, `${r.status} ${r.msg || ""}`);
}

async function s8_reconnect() {
  const t0 = Date.now();
  const { socket } = await connectAndHandshake(SERVER_URL);
  socket.disconnect();
  await sleep(1000);
  if (socket.connected) { record("S8", "断开重连", "FAIL", Date.now() - t0, "disconnect 后仍为 connected"); socket.close(); return; }
  // 同实例重连（模拟断网恢复）
  socket.connect();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("重连超时")), 15000);
    socket.once("connect", () => { clearTimeout(timer); resolve(); });
  });
  const [printers] = await waitEvent(socket, "printerList", 10000);
  record("S8", "断开重连", "PASS", Date.now() - t0, `重连成功，printerList ${printers.length} 台`);
  socket.close();
}

async function s9_malformed(socket) {
  const t0 = Date.now();
  // 1) news 缺 html 字段
  socket.emit("news", { templateId: nextTid(), printer: "x" });
  // 2) news-server 畸形 JSON 字符串
  socket.emit("news-server", "{{{not-a-json");
  // 3) news-server 空对象
  socket.emit("news-server", JSON.stringify({}));
  await sleep(2000);
  // 连接必须仍健康：refreshPrinterList 有响应
  socket.emit("refreshPrinterList");
  try {
    await waitEvent(socket, "printerList", 10000);
    record("S9", "非法数据容错（连接不中断）", "PASS", Date.now() - t0, "3 条畸形报文后服务仍响应");
  } catch (e) {
    record("S9", "非法数据容错（连接不中断）", "FAIL", Date.now() - t0, e.message);
  }
}

async function s10_address(socket) {
  const t0 = Date.now();
  try {
    socket.emit("address", "ip");
    const [type, addr, err] = await waitEvent(socket, "address", 10000, (t) => t === "ip");
    record("S10", "address 地址查询", err ? "WARN" : "PASS", Date.now() - t0, `ip=${addr}${err ? ` err=${err}` : ""}`);
  } catch (e) {
    record("S10", "address 地址查询", "FAIL", Date.now() - t0, e.message);
  }
}

// ========== 主流程 ==========
(async () => {
  console.log(`\n=== Electron 44 远程兼容性测试 ===`);
  console.log(`目标: ${SERVER_URL}${SKIP_PRINT ? "  [skip-print: 不出纸]" : `  [并发: ${CONCURRENCY}，会真实出纸]`}\n`);

  let ctx = null;
  try {
    ctx = await s1_handshake();
  } catch (e) {
    record("S1", "连接握手 + printerList 推送", "FAIL", 0, e.message);
    summary();
    process.exit(1);
  }
  const { socket, printers, defaultPrinter } = ctx;
  const printer = PRINTER_ARG || defaultPrinter;

  const printable = printer && printers.some((p) => p.name === printer);
  if (!SKIP_PRINT && !printable) {
    console.log(`  \x1b[33m提示：未找到可用打印机（指定 "${printer}"），打印场景将跳过\x1b[0m`);
  }

  try {
    await s2_refresh(socket).catch((e) => record("S2", "refreshPrinterList 主动刷新", "FAIL", 0, e.message));

    if (SKIP_PRINT) {
      for (const [id, name] of [["S3", "news 单任务静默打印"], ["S4", "多副本打印 copies=3"], ["S5", "无效打印机容错（回退默认）"], ["S6", `并发风暴 x${CONCURRENCY}`], ["S7", "news-server 模板渲染管线"]]) {
        record(id, name, "SKIP", 0, "--skip-print");
      }
    } else if (printable) {
      await s3_singlePrint(socket, printer).catch((e) => record("S3", "news 单任务静默打印", "FAIL", 0, e.message));
      await s4_copies(socket, printer).catch((e) => record("S4", "多副本打印 copies=3", "FAIL", 0, e.message));
      await s5_invalidPrinter(socket, printer).catch((e) => record("S5", "无效打印机容错（回退默认）", "FAIL", 0, e.message));
      await s6_storm(socket, printer).catch((e) => record("S6", `并发风暴 x${CONCURRENCY}`, "FAIL", 0, e.message));
      await s7_newsServer(socket, printer).catch((e) => record("S7", "news-server 模板渲染管线", "FAIL", 0, e.message));
    } else {
      for (const [id, name] of [["S3", "news 单任务静默打印"], ["S4", "多副本打印 copies=3"], ["S5", "无效打印机容错（回退默认）"], ["S6", `并发风暴 x${CONCURRENCY}`], ["S7", "news-server 模板渲染管线"]]) {
        record(id, name, "SKIP", 0, "无可用打印机");
      }
    }

    await s8_reconnect().catch((e) => record("S8", "断开重连", "FAIL", 0, e.message));
    await s9_malformed(socket).catch((e) => record("S9", "非法数据容错（连接不中断）", "FAIL", 0, e.message));
    await s10_address(socket).catch((e) => record("S10", "address 地址查询", "FAIL", 0, e.message));
  } finally {
    socket.close();
  }

  summary();
})().catch((e) => {
  console.error("脚本异常:", e);
  process.exit(1);
});

function summary() {
  const pass = results.filter((r) => r.status === "PASS").length;
  const warn = results.filter((r) => r.status === "WARN").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const skip = results.filter((r) => r.status === "SKIP").length;
  console.log(`\n=== 汇总: PASS ${pass} | WARN ${warn} | SKIP ${skip} | FAIL ${fail} ===`);
  if (fail > 0) {
    console.log("失败场景:");
    results.filter((r) => r.status === "FAIL").forEach((r) => console.log(`  - ${r.id} ${r.name}: ${r.detail}`));
  }
  process.exit(fail > 0 ? 1 : 0);
}
