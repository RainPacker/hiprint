"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

// 持久化文件路径
const STORE_DIR = path.join(app.getPath("userData"), "print-queue");
const STORE_FILE = path.join(STORE_DIR, "pending-tasks.json");

// 内存缓存，避免每次操作都读文件
let _taskCache = null;
let _saveTimer = null;
const SAVE_DEBOUNCE_MS = 500;
// 持久化任务数上限：防止异常场景（反复崩溃重启）任务无限堆积，
// 文件越积越大 → 每次启动全量读入内存 + 同步写大 JSON → 内存暴涨/主进程阻塞闪退
const MAX_PERSISTED_TASKS = 200;

/**
 * 确保存储目录存在
 */
function ensureDir() {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

/**
 * 从文件加载任务到内存缓存
 * @returns {Array} 任务列表
 */
function loadTasks() {
  try {
    ensureDir();
    if (!fs.existsSync(STORE_FILE)) {
      _taskCache = [];
      return _taskCache;
    }
    const content = fs.readFileSync(STORE_FILE, "utf-8");
    if (!content || content.trim() === "") {
      _taskCache = [];
      return _taskCache;
    }
    _taskCache = JSON.parse(content);
    return _taskCache;
  } catch (err) {
    console.error("[store] 读取持久化任务失败:", err.message);
    _taskCache = [];
    return _taskCache;
  }
}

/**
 * 获取内存缓存（首次访问时从文件加载）
 */
function getCache() {
  if (_taskCache === null) {
    loadTasks();
  }
  return _taskCache;
}

/**
 * 防抖写入：延迟 500ms 合并多次操作，避免高频同步 IO 阻塞主线程
 */
function scheduleSave() {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
  }
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    flushSave();
  }, SAVE_DEBOUNCE_MS);
}

/**
 * 立即写入文件
 */
function flushSave() {
  try {
    ensureDir();
    if (_saveTimer) {
      clearTimeout(_saveTimer);
      _saveTimer = null;
    }
    fs.writeFileSync(STORE_FILE, JSON.stringify(_taskCache || [], null, 2), "utf-8");
  } catch (err) {
    console.error("[store] 写入持久化任务失败:", err.message);
  }
}

/**
 * 保存一个任务到持久化存储（操作内存缓存，防抖写入文件）
 * @param {Object} data - 任务数据
 */
function addTask(data) {
  const tasks = getCache();
  // 只存储可序列化的字段，去掉运行时字段
  const storeData = {
    taskId: data.taskId,
    printer: data.printer,
    _resolvedPrinter: data._resolvedPrinter,
    html: data.html,
    template: data.template,
    // news-server 任务的渲染参数（index.html 中使用 data.data 渲染），不存则恢复后无法重渲染
    params: data.params !== undefined ? data.params : data.data,
    templateId: data.templateId,
    title: data.title,
    socketId: data.socketId,
    silent: data.silent,
    printBackground: data.printBackground,
    color: data.color,
    margins: data.margins,
    landscape: data.landscape,
    scaleFactor: data.scaleFactor,
    pagesPerSheet: data.pagesPerSheet,
    collate: data.collate,
    // copies 归一化：0/负数为非法值（Windows DEVMODE.dmCopies 必须>=1），
    // news-server 实测会发 copies:0，原样持久化会导致恢复后打印崩溃
    copies: data.copies && data.copies > 0 ? Math.floor(data.copies) : 1,
    pageRanges: data.pageRanges,
    duplexMode: data.duplexMode,
    dpi: data.dpi,
    header: data.header,
    footer: data.footer,
    pageSize: data.pageSize,
    // 重试计数：用于识别"毒任务"（一渲染/打印就崩溃），超过次数上限后启动时丢弃
    retryCount: data.retryCount || 0,
    status: "pending",
    createdAt: Date.now(),
  };
  tasks.push(storeData);
  // 超上限时丢弃最旧的任务，防止持久化文件无限膨胀
  if (_taskCache.length > MAX_PERSISTED_TASKS) {
    const dropped = _taskCache.length - MAX_PERSISTED_TASKS;
    _taskCache = _taskCache.slice(-MAX_PERSISTED_TASKS);
    console.log(`[store] 持久化任务超过上限(${MAX_PERSISTED_TASKS})，丢弃最旧 ${dropped} 个`);
  }
  scheduleSave();
}

/**
 * 批量保存所有任务（直接替换缓存并立即写入，退出时使用）
 * @param {Array} tasksData - 任务数据数组
 */
function saveAllTasks(tasksData) {
  _taskCache = tasksData.map((data) => ({
    taskId: data.taskId,
    printer: data.printer,
    _resolvedPrinter: data._resolvedPrinter,
    html: data.html,
    template: data.template,
    params: data.params !== undefined ? data.params : data.data,
    templateId: data.templateId,
    title: data.title,
    socketId: data.socketId,
    silent: data.silent,
    printBackground: data.printBackground,
    color: data.color,
    margins: data.margins,
    landscape: data.landscape,
    scaleFactor: data.scaleFactor,
    pagesPerSheet: data.pagesPerSheet,
    collate: data.collate,
    copies: data.copies && data.copies > 0 ? Math.floor(data.copies) : 1,
    pageRanges: data.pageRanges,
    duplexMode: data.duplexMode,
    dpi: data.dpi,
    header: data.header,
    footer: data.footer,
    pageSize: data.pageSize,
    retryCount: data.retryCount || 0,
    status: "pending",
    // 保留原始创建时间，用于启动时按时间过滤过期任务
    createdAt: data.createdAt || Date.now(),
  }));
  flushSave();
}

/**
 * 更新任务的重试计数（恢复任务时递增，超过上限即视为毒任务丢弃）
 * @param {number} taskId - 任务ID
 * @param {number} retryCount - 新的重试次数
 */
function updateRetry(taskId, retryCount) {
  const tasks = getCache();
  const task = tasks.find((t) => t.taskId === taskId);
  if (task) {
    task.retryCount = retryCount;
    task.lastRetryAt = Date.now();
    scheduleSave();
  }
}

/**
 * 获取持久化存储统计信息（用于启动诊断日志）
 * @returns {{count: number, fileBytes: number}}
 */
function getStoreInfo() {
  try {
    const count = getCache().length;
    let fileBytes = 0;
    if (fs.existsSync(STORE_FILE)) {
      fileBytes = fs.statSync(STORE_FILE).size;
    }
    return { count, fileBytes };
  } catch (err) {
    return { count: 0, fileBytes: 0, error: err.message };
  }
}

/**
 * 标记任务为打印中
 * @param {number} taskId - 任务ID
 */
function markPrinting(taskId) {
  const tasks = getCache();
  const task = tasks.find((t) => t.taskId === taskId);
  if (task) {
    task.status = "printing";
    scheduleSave();
  }
}

/**
 * 移除一个已完成的任务
 * @param {number} taskId - 任务ID
 */
function removeTask(taskId) {
  const tasks = getCache();
  _taskCache = tasks.filter((t) => t.taskId !== taskId);
  scheduleSave();
}

/**
 * 获取所有待恢复的任务（pending + printing 都恢复为 pending 重试）
 * @returns {Array} 待恢复的任务列表
 */
function getPendingTasks() {
  const tasks = getCache();
  // printing 状态的任务说明应用在打印过程中关闭了，需要重试
  return tasks.map((t) => ({
    ...t,
    status: "pending",
  }));
}

/**
 * 清空所有持久化任务
 */
function clearAll() {
  _taskCache = [];
  flushSave();
}

/**
 * 获取待处理任务数量
 * @returns {number}
 */
function getPendingCount() {
  return getCache().length;
}

module.exports = {
  addTask,
  saveAllTasks,
  updateRetry,
  markPrinting,
  removeTask,
  getPendingTasks,
  clearAll,
  getPendingCount,
  getStoreInfo,
  flushSave,
};
