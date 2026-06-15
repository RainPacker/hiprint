"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

// 持久化文件路径
const STORE_DIR = path.join(app.getPath("userData"), "print-queue");
const STORE_FILE = path.join(STORE_DIR, "pending-tasks.json");

/**
 * 确保存储目录存在
 */
function ensureDir() {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

/**
 * 读取所有待处理任务
 * @returns {Array} 任务列表
 */
function loadTasks() {
  try {
    ensureDir();
    if (!fs.existsSync(STORE_FILE)) {
      return [];
    }
    const content = fs.readFileSync(STORE_FILE, "utf-8");
    if (!content || content.trim() === "") {
      return [];
    }
    return JSON.parse(content);
  } catch (err) {
    console.error("[store] 读取持久化任务失败:", err.message);
    return [];
  }
}

/**
 * 保存所有待处理任务到文件
 * @param {Array} tasks - 任务列表
 */
function saveTasks(tasks) {
  try {
    ensureDir();
    fs.writeFileSync(STORE_FILE, JSON.stringify(tasks, null, 2), "utf-8");
  } catch (err) {
    console.error("[store] 保存持久化任务失败:", err.message);
  }
}

/**
 * 添加一个任务到持久化存储
 * @param {Object} data - 任务数据
 */
function addTask(data) {
  const tasks = loadTasks();
  // 只存储可序列化的字段，去掉运行时字段
  const storeData = {
    taskId: data.taskId,
    printer: data.printer,
    _resolvedPrinter: data._resolvedPrinter,
    html: data.html,
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
  saveTasks(tasks);
}

/**
 * 标记任务为打印中
 * @param {number} taskId - 任务ID
 */
function markPrinting(taskId) {
  const tasks = loadTasks();
  const task = tasks.find((t) => t.taskId === taskId);
  if (task) {
    task.status = "printing";
    saveTasks(tasks);
  }
}

/**
 * 移除一个已完成的任务
 * @param {number} taskId - 任务ID
 */
function removeTask(taskId) {
  const tasks = loadTasks();
  const filtered = tasks.filter((t) => t.taskId !== taskId);
  saveTasks(filtered);
}

/**
 * 获取所有待恢复的任务（pending + printing 都恢复为 pending 重试）
 * @returns {Array} 待恢复的任务列表
 */
function getPendingTasks() {
  const tasks = loadTasks();
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
  saveTasks([]);
}

/**
 * 获取待处理任务数量
 * @returns {number}
 */
function getPendingCount() {
  return loadTasks().length;
}

module.exports = {
  addTask,
  markPrinting,
  removeTask,
  getPendingTasks,
  clearAll,
  getPendingCount,
};
