"use strict";
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

/**
 * 崩溃日志目录
 */
function getLogDir() {
  return path.join(app.getPath("userData"), "logs");
}

/**
 * 写入崩溃日志到文件（方便定位偶发闪退）
 * @param {string} category - 日志分类
 * @param {Error|string} err - 错误对象或消息
 */
function logError(category, err) {
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
    const line = `[${timeStr}] [${category}] ${msg}\n`;
    fs.appendFileSync(logFile, line, "utf-8");
    // 同时输出到控制台
    console.error(`[${category}]`, msg);
  } catch (e) {
    // 日志写入失败不能影响主流程
    console.error("[logError] 写入日志失败:", e.message);
  }
}

/**
 * 检查主窗口是否可用（非空且未销毁且webContents未销毁）
 */
function isMainWindowAvailable() {
  return (
    MAIN_WINDOW &&
    !MAIN_WINDOW.isDestroyed() &&
    !MAIN_WINDOW.webContents.isDestroyed()
  );
}

/**
 * 安全地向主窗口发送 IPC 消息
 */
function safeSendToMain(channel, ...args) {
  try {
    if (isMainWindowAvailable()) {
      MAIN_WINDOW.webContents.send(channel, ...args);
    }
  } catch (err) {
    logError("safeSendToMain", err);
  }
}

/**
 * 安全地获取打印机列表
 * @returns {Array} 打印机列表，失败返回空数组
 */
function safeGetPrinters() {
  try {
    if (isMainWindowAvailable()) {
      return MAIN_WINDOW.webContents.getPrinters();
    }
  } catch (err) {
    logError("safeGetPrinters", err);
  }
  return [];
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
exports.isMainWindowAvailable = isMainWindowAvailable;
exports.safeSendToMain = safeSendToMain;
exports.safeGetPrinters = safeGetPrinters;
exports.saveConfig = saveConfig;
exports.getConfig = getConfig;
