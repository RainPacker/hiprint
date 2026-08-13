"use strict";
const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

/**
 * 崩溃日志目录
 */
function getLogDir() {
  return path.join(app.getPath("userData"), "logs");
}

/**
 * 写入日志到文件（方便定位偶发闪退）
 * @param {string} category - 日志分类
 * @param {Error|string} err - 错误对象或消息
 * @param {string} level - 日志级别: "ERROR" | "INFO"
 */
function writeLog(category, err, level) {
  try {
    const logDir = getLogDir();
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const logFile = path.join(logDir, `crash-${dateStr}.log`);
    const timeStr = now.toISOString();
    const msg = err && err.stack ? err.stack : String(err);
    const line = `[${timeStr}] [${level || "ERROR"}] [${category}] ${msg}\n`;
    // 使用 fs.appendFileSync 同步写入，确保硬崩溃前日志落地
    fs.appendFileSync(logFile, line, "utf-8");
    // 同时输出到控制台
    if (level === "INFO") {
      console.log(`[${category}]`, msg);
    } else {
      console.error(`[${category}]`, msg);
    }
  } catch (e) {
    // 日志写入失败不能影响主流程
    console.error("[writeLog] 写入日志失败:", e.message);
  }
}

/**
 * 强制将日志文件刷盘（在怀疑即将崩溃时调用）
 * 防止 fs.appendFileSync 写入的内容仍停留在 OS 缓存中
 */
function flushLogs() {
  try {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const logFile = path.join(getLogDir(), `crash-${dateStr}.log`);
    if (fs.existsSync(logFile)) {
      const fd = fs.openSync(logFile, "r");
      try { fs.fsyncSync(fd); } catch (e) {}
      fs.closeSync(fd);
    }
  } catch (e) {
    // 忽略刷盘失败
  }
}

/**
 * 写入错误日志
 * 错误日志可能预示即将崩溃，立即刷盘确保不丢失
 */
function logError(category, err) {
  writeLog(category, err, "ERROR");
  flushLogs();
}

/**
 * 写入信息日志（用于排查流程问题）
 */
function logInfo(category, msg) {
  writeLog(category, msg, "INFO");
}

/**
 * 检查主窗口是否可用（非空且未销毁且webContents未销毁）
 */
function isMainWindowAvailable() {
  if (!MAIN_WINDOW) {
    return false;
  }
  try {
    return (
      !MAIN_WINDOW.isDestroyed() &&
      MAIN_WINDOW.webContents &&
      !MAIN_WINDOW.webContents.isDestroyed()
    );
  } catch (err) {
    logError("isMainWindowAvailable-check", err);
    return false;
  }
}

/**
 * 安全地向主窗口发送 IPC 消息
 */
function safeSendToMain(channel, ...args) {
  try {
    if (isMainWindowAvailable()) {
      MAIN_WINDOW.webContents.send(channel, ...args);
    } else {
      logInfo("safeSendToMain-skip", `channel=${channel} 主窗口不可用，跳过发送`);
    }
  } catch (err) {
    logError("safeSendToMain", `channel=${channel} ${err.message || err}`);
  }
}

/**
 * 安全地获取打印机列表
 * @returns {Array} 打印机列表，失败返回空数组
 */
function safeGetPrinters() {
  try {
    if (isMainWindowAvailable()) {
      const printers = MAIN_WINDOW.webContents.getPrinters();
      logInfo("safeGetPrinters", `获取到 ${printers.length} 台打印机`);
      return printers;
    } else {
      logInfo("safeGetPrinters-skip", "主窗口不可用，返回空列表");
    }
  } catch (err) {
    logError("safeGetPrinters", err);
  }
  return [];
}

/**
 * 设置指定进程为高优先级
 * 仅使用 os.setPriority（不阻塞主线程，不用 execSync）
 * @param {number} pid - 目标进程ID
 * @returns {string} 实际设置的优先级标签
 */
function setProcessHighPriority(pid) {
  logInfo("setProcessHighPriority-start", `PID=${pid}`);
  // os.setPriority 使用 POSIX 值：-20=实时, -14=高
  const priorityLevels = [
    { value: -20, label: "实时" },
    { value: -14, label: "高" },
  ];

  for (const level of priorityLevels) {
    try {
      os.setPriority(pid, level.value);
      logInfo("setProcessHighPriority", `PID=${pid} 优先级已设置为${level.label}`);
      return level.label;
    } catch (err) {
      logInfo("setProcessHighPriority-retry", `PID=${pid} 尝试${level.label}失败: ${err.message}`);
    }
  }
  logError("setProcessHighPriority", `PID=${pid} 优先级设置失败`);
  return "普通";
}

/**
 * 批量设置当前应用的所有同名进程为高优先级
 * 用 tasklist 查找所有同名进程PID，再用 os.setPriority 逐个设置
 * 不依赖 PowerShell，兼容所有 Windows 版本
 * @returns {string} 优先级标签
 */
function setAllProcessesHighPriority() {
  const execName = path.basename(process.execPath);
  logInfo("setAllProcessesHighPriority-start", `进程名="${execName}"`);

  // 用 tasklist 查找所有同名进程的 PID
  let pids = [];
  try {
    const output = execSync(
      `tasklist /FI "IMAGENAME eq ${execName}" /FO CSV /NH`,
      { stdio: "pipe", timeout: 10000 }
    ).toString();
    // 输出格式: "hiprint.exe","1234","Console","1","50,000 K"
    const lines = output.trim().split("\n");
    for (const line of lines) {
      const match = line.match(/"([^"]+)","(\d+)"/);
      if (match) {
        pids.push(parseInt(match[2], 10));
      }
    }
    logInfo("setAllProcessesHighPriority", `找到 ${pids.length} 个进程: ${pids.join(", ")}`);
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : err.message;
    logError("setAllProcessesHighPriority-tasklist", stderr);
    return "普通";
  }

  if (pids.length === 0) {
    logError("setAllProcessesHighPriority", "未找到任何同名进程");
    return "普通";
  }

  // 尝试 Realtime(-20) -> High(-14) 逐个设置
  const priorityLevels = [
    { value: -20, label: "实时" },
    { value: -14, label: "高" },
  ];

  for (const level of priorityLevels) {
    let successCount = 0;
    const failedPids = [];
    for (const pid of pids) {
      try {
        os.setPriority(pid, level.value);
        successCount++;
      } catch (err) {
        failedPids.push(pid);
      }
    }

    logInfo("setAllProcessesHighPriority", `${level.label}: 成功 ${successCount}/${pids.length}，失败 ${failedPids.length} ${failedPids.length > 0 ? "PIDs=" + failedPids.join(",") : ""}`);

    // 全部成功或至少成功一半就返回
    if (successCount === pids.length) {
      logInfo("setAllProcessesHighPriority-done", `所有进程优先级已设置为${level.label}`);
      return level.label;
    }
    // 如果至少成功了一半，也认为可以接受，继续尝试更高优先级失败就用这个
    if (successCount > 0 && level.label === "高") {
      logInfo("setAllProcessesHighPriority-done", `部分进程优先级已设置为${level.label}`);
      return level.label;
    }
  }

  logError("setAllProcessesHighPriority", `所有优先级设置方法均失败，进程数=${pids.length}`);
  return "普通";
}

/**
 * 应用配置文件路径
 */
function getConfigFile() {
  return path.join(app.getPath("userData"), "app-config.json");
}

/**
 * 保存配置项（持久化到文件，重启后可读取）
 * @param {string} key - 配置键
 * @param {*} value - 配置值
 */
function saveConfig(key, value) {
  try {
    const configFile = getConfigFile();
    let config = {};
    if (fs.existsSync(configFile)) {
      config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    }
    config[key] = value;
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    logError("saveConfig", err);
  }
}

/**
 * 读取配置项
 * @param {string} key - 配置键
 * @param {*} defaultValue - 默认值
 * @returns {*} 配置值
 */
function getConfig(key, defaultValue) {
  try {
    const configFile = getConfigFile();
    if (!fs.existsSync(configFile)) return defaultValue;
    const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    return config[key] !== undefined ? config[key] : defaultValue;
  } catch (err) {
    logError("getConfig", err);
    return defaultValue;
  }
}

/**
 * 退出应用
 */
exports.appQuit = function() {
  try {
    if (MAIN_WINDOW && !MAIN_WINDOW.isDestroyed()) {
      MAIN_WINDOW.destroy();
    }
  } catch (err) {
    logError("appQuit", err);
  }
  app.quit();
};

// 导出工具函数
exports.logError = logError;
exports.logInfo = logInfo;
exports.flushLogs = flushLogs;
exports.isMainWindowAvailable = isMainWindowAvailable;
exports.safeSendToMain = safeSendToMain;
exports.safeGetPrinters = safeGetPrinters;
exports.setProcessHighPriority = setProcessHighPriority;
exports.setAllProcessesHighPriority = setAllProcessesHighPriority;
exports.saveConfig = saveConfig;
exports.getConfig = getConfig;
