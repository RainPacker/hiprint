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
    copies: data.copies,
    pageRanges: data.pageRanges,
    duplexMode: data.duplexMode,
    dpi: data.dpi,
    header: data.header,
    footer: data.footer,
    pageSize: data.pageSize,
    status: "pending",
    createdAt: Date.now(),
  };
  tasks.push(storeData);
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
    copies: data.copies,
    pageRanges: data.pageRanges,
    duplexMode: data.duplexMode,
    dpi: data.dpi,
    header: data.header,
    footer: data.footer,
    pageSize: data.pageSize,
    status: "pending",
    createdAt: Date.now(),
  }));
  flushSave();
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
  markPrinting,
  removeTask,
  getPendingTasks,
  clearAll,
  getPendingCount,
  flushSave,
};
