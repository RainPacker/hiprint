"use strict";

const { app, BrowserWindow, ipcMain, Tray, Menu } = require("electron");
const path = require("path");
const helper = require("./helper");
const { logError, logInfo, flushLogs, truncateForLog, safeSendToMain, safeGetPrinters, isMainWindowAvailable, saveConfig, setProcessHighPriority } = helper;
const address = require("address");
const ipp = require("ipp");
const store = require("./store");

// ========== 按打印机分队列架构 ==========
// 不同打印机可并行处理，同一打印机严格串行
// 每台打印机拥有独立的 BrowserWindow，避免 HTML 互相覆盖
// 集成本地持久化，应用关闭/崩溃时任务不丢失

// 自增任务ID
let _taskIdCounter = 0;
function nextTaskId() {
  return ++_taskIdCounter;
}

// 任务超时时间（毫秒）
const TASK_TIMEOUT = 30000;
// 模板渲染超时时间（毫秒）
const RENDER_TIMEOUT = 15000;
// 空闲窗口回收延时（毫秒），打印完成后空闲此时间则自动销毁
const IDLE_WINDOW_TIMEOUT = 60000;
// 最少保留的窗口数，空闲回收时不低于此数量
// 从5降为1：每个渲染进程约占200-400MB，多保底窗口会导致低内存服务器OOM闪退
const MIN_KEEP_WINDOWS = 1;
// 单个窗口最大复用次数，超过后强制销毁重建，避免渲染进程内存累积导致硬崩溃
// 渲染进程长期不重启会累积 hiprint 状态/内存碎片，最终可能在 IPC send 时引发底层崩溃
const MAX_WINDOW_REUSE = 50;

// ========== 启动恢复防护（防止缓存任务导致"启动即打印中→闪退"死循环） ==========
// 单个任务最大重试次数：超过视为"毒任务"（一渲染/打印就崩溃），启动恢复时直接丢弃
const MAX_TASK_RETRY = 3;
// 任务最长保留时间：超过 24 小时的历史任务直接丢弃（打印早已无意义）
const TASK_MAX_AGE_MS = 24 * 3600 * 1000;
// 单次启动最多恢复的任务数：防止启动瞬间创建大量打印窗口打爆内存
const MAX_RESTORE_TASKS = 50;
// 单打印机队列长度上限：超过则拒绝新任务并通知客户端，防止内存无限增长
const MAX_QUEUE_PER_PRINTER = 100;

// ========== 看门狗（保活 + 诊断日志） ==========
// 心跳周期（毫秒）
const WATCHDOG_INTERVAL = 10000;
// 事件循环阻塞告警阈值（毫秒），超过说明主进程"无响应"
const EVENTLOOP_LAG_ALERT = 5000;
// 内存告警阈值：超过则回收空闲打印窗口
const MEM_WARN_BYTES = 1100 * 1048576;
// 内存危险阈值：超过则持久化任务后自动重启应用（保活，防 OOM 闪退）
const MEM_CRITICAL_BYTES = 1600 * 1048576;

// 打印机队列映射表
// key: 打印机名称, value: { queue, isPrinting, currentTask, window, timer, idleTimer, reuseCount, renderGone, pauseUntil }
//   reuseCount: 该窗口已被复用打印的次数，达到 MAX_WINDOW_REUSE 后强制销毁重建
//   renderGone: 渲染进程崩溃标志，true 时该窗口不可用，必须重建
//   pauseUntil: 队列暂停截止时间戳（渲染崩溃后冷却 1 秒，避免毒任务连续崩溃打爆 CPU）
const printerQueues = new Map();

// 渲染中的任务映射表（news-server 专用）
// key: taskId, value: { data, socketId, timer }
const renderingTasks = new Map();

/**
 * 获取或创建指定打印机的队列
 */
function getPrinterQueue(printerName) {
  if (!printerQueues.has(printerName)) {
    printerQueues.set(printerName, {
      queue: [],
      isPrinting: false,
      currentTask: null,
      window: null,
      timer: null,
      idleTimer: null, // 空闲窗口自动回收定时器
      reuseCount: 0,   // 当前窗口已复用打印次数
      renderGone: false, // 渲染进程是否已崩溃
      pauseUntil: 0,   // 队列暂停截止时间戳（渲染崩溃后冷却）
    });
  }
  return printerQueues.get(printerName);
}

/**
 * 获取所有队列中的待处理任务总数
 */
function getTotalPendingCount() {
  let total = 0;
  printerQueues.forEach((pq) => {
    total += pq.queue.length + (pq.isPrinting ? 1 : 0);
  });
  return total;
}

/**
 * 解析实际打印机名称
 * 如果指定的打印机不存在，回退到默认打印机
 * WinServer 启动时 Print Spooler 可能未就绪，返回空列表需安全处理
 */
function resolvePrinterName(requestedPrinter) {
  const printers = safeGetPrinters();
  if (!printers || printers.length === 0) {
    // 打印机列表为空（Spooler 未就绪），返回原始请求名，后续打印时会失败但不崩溃
    logError("resolvePrinterName", "打印机列表为空，Print Spooler 可能未就绪");
    return requestedPrinter || "";
  }
  let havePrinter = false;
  let defaultPrinter = "";
  printers.forEach((element) => {
    if (element.name === requestedPrinter) {
      havePrinter = true;
    }
    if (element.isDefault) {
      defaultPrinter = element.name;
    }
  });
  return havePrinter ? requestedPrinter : defaultPrinter;
}

/**
 * 将打印任务加入对应打印机的队列
 */
function enqueuePrintTask(data) {
  // news-server 已在入队前分配了 taskId，不要覆盖
  if (!data.taskId) {
    data.taskId = nextTaskId();
  }

  // 解析实际打印机名称
  const printerName = resolvePrinterName(data.printer);
  data.printer = printerName;
  data._resolvedPrinter = printerName;

  logInfo("enqueuePrintTask", `taskId=${data.taskId} printer="${printerName}" templateId=${data.templateId || "N/A"} htmlLen=${data.html ? data.html.length : 0}`);

  const pq = getPrinterQueue(printerName);

  // 归一化 copies：0/负数为非法值（Windows DEVMODE.dmCopies 必须>=1），
  // 部分打印机驱动收到非法 copies 会崩溃。入队时归一化，保证持久化的任务也是合法值
  if (!data.copies || data.copies < 1) {
    data.copies = 1;
  }

  // 队列上限保护：防止客户端异常（如死循环重发）导致内存无限增长
  if (pq.queue.length >= MAX_QUEUE_PER_PRINTER) {
    logError("enqueuePrintTask-overflow", `printer="${printerName}" 队列已满(${MAX_QUEUE_PER_PRINTER})，拒绝 taskId=${data.taskId}`);
    const socket = socketStore[data.socketId];
    if (socket) {
      try {
        socket.emit("error", { msg: `打印队列已满(${MAX_QUEUE_PER_PRINTER})，任务被拒绝`, templateId: data.templateId });
      } catch (e) { /* socket 可能已断开 */ }
    }
    store.removeTask(data.taskId);
    return;
  }

  pq.queue.push(data);

  // 持久化：news-server 已在渲染前写入，这里只对 news 接口写入
  if (!renderingTasks.has(data.taskId)) {
    store.addTask(data);
  }

  safeSendToMain("printTask", getTotalPendingCount());
  processNextTask(printerName);
}

/**
 * 处理指定打印机队列中的下一个任务
 */
function processNextTask(printerName) {
  const pq = getPrinterQueue(printerName);
  if (pq.isPrinting || pq.queue.length === 0) {
    return;
  }
  // 渲染进程崩溃后的冷却期内不启动新任务，避免毒任务连续崩溃打爆 CPU
  if (pq.pauseUntil && Date.now() < pq.pauseUntil) {
    return;
  }

  pq.isPrinting = true;
  const data = pq.queue.shift();
  pq.currentTask = data; // 记录当前正在打印的任务

  logInfo("processNextTask", `taskId=${data.taskId} printer="${printerName}" 队列剩余=${pq.queue.length}`);

  // 持久化：标记为打印中
  store.markPrinting(data.taskId);

  // 超时保护
  pq.timer = setTimeout(() => {
    logError("print-timeout", `taskId=${data.taskId} printer="${printerName}" 超时(${TASK_TIMEOUT}ms)`);
    onTaskDone(printerName, data.taskId, data.socketId, data.templateId, false, "打印超时");
  }, TASK_TIMEOUT);

  // 确保窗口已创建并等待加载完成
  const { window: win, isNew } = ensurePrinterWindow(printerName);

  logInfo("processNextTask-window", `taskId=${data.taskId} windowReady=${!isNew} isNew=${isNew} reuseCount=${pq.reuseCount}`);

  const sendPrintNew = () => {
    try {
      // 检查窗口和 webContents 是否仍然可用
      if (win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) {
        logError("processNextTask-send", `taskId=${data.taskId} 窗口已销毁，任务标记为失败`);
        onTaskDone(printerName, data.taskId, data.socketId, data.templateId, false, "打印窗口已销毁");
        return;
      }
      // 如果渲染进程已被标记崩溃（事件可能在 ensurePrinterWindow 之后触发），跳过发送并重建
      if (pq.renderGone) {
        logError("processNextTask-send", `taskId=${data.taskId} 渲染进程已崩溃，标记任务失败并重建窗口`);
        onTaskDone(printerName, data.taskId, data.socketId, data.templateId, false, "渲染进程已崩溃");
        return;
      }
      // 发送 print-new 是硬崩溃高发点（渲染进程可能已死但 isDestroyed 仍返回 false）
      // 提前刷盘确保崩溃前最后一条日志落地
      logInfo("processNextTask-send", `taskId=${data.taskId} 即将调用 webContents.send print-new`);
      flushLogs();
      win.webContents.send("print-new", data);
      // 发送成功后递增复用计数（用于触发定期重建）
      pq.reuseCount++;
      logInfo("processNextTask-send", `taskId=${data.taskId} 已发送 print-new reuseCount=${pq.reuseCount}`);
    } catch (err) {
      logError("processNextTask-send", `taskId=${data.taskId} ${err.message}`);
      // 发送失败，标记任务失败并继续下一个，避免队列卡死
      onTaskDone(printerName, data.taskId, data.socketId, data.templateId, false, "发送打印数据失败: " + err.message);
    }
  };

  if (isNew) {
    // 使用 once 避免重复监听
    win.webContents.once("dom-ready", sendPrintNew);
  } else {
    sendPrintNew();
  }
}

/**
 * 统计当前活跃的打印窗口数
 * @returns {number}
 */
function countActiveWindows() {
  let count = 0;
  printerQueues.forEach((pq) => {
    if (pq.window && !pq.window.isDestroyed()) {
      count++;
    }
  });
  return count;
}

/**
 * 查找一个空闲窗口（非打印中、队列为空）并从原队列中剥离
 * @returns {BrowserWindow|null}
 */
function findAndDetachIdleWindow() {
  let idleEntry = null;
  let idleKey = null;
  printerQueues.forEach((pq, key) => {
    if (
      pq.window &&
      !pq.window.isDestroyed() &&
      !pq.isPrinting &&
      pq.queue.length === 0 &&
      !pq.renderGone // 跳过渲染进程已崩溃的窗口
    ) {
      idleEntry = pq;
      idleKey = key;
    }
  });

  if (idleEntry && idleKey) {
    const win = idleEntry.window;
    // 取消原队列的空闲回收定时器
    if (idleEntry.idleTimer) {
      clearTimeout(idleEntry.idleTimer);
      idleEntry.idleTimer = null;
    }
    idleEntry.window = null;
    logInfo("findAndDetachIdleWindow", `从打印机 "${idleKey}" 剥离空闲窗口`);
    return win;
  }
  return null;
}

/**
 * 创建新的打印窗口
 * @returns {BrowserWindow}
 */
function createPrinterWindow() {
  const windowOptions = {
    width: 100,
    height: 100,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
  };

  const win = new BrowserWindow(windowOptions);

  // 渲染进程崩溃自动恢复
  win.webContents.on("render-process-gone", (event, details) => {
    logError("printWindow-render-gone", `reason=${details.reason} exitCode=${details.exitCode}`);
    // 找到该窗口对应的队列，标记崩溃并重置状态
    for (const [name, pq] of printerQueues) {
      if (pq.window === win) {
        logInfo("printWindow-render-gone", `printer="${name}" 渲染进程崩溃，重置队列 reuseCount=${pq.reuseCount}`);
        if (pq.timer) {
          clearTimeout(pq.timer);
          pq.timer = null;
        }
        // 关键修复：正在打印的任务必须走完成回调（从持久化中移除），
        // 旧逻辑直接丢弃任务 → 残留在 pending-tasks.json → 每次启动重试 →
        // 毒任务造成"启动即打印中→闪退"死循环
        const task = pq.currentTask;
        pq.currentTask = null;
        pq.isPrinting = false;
        pq.window = null;
        pq.renderGone = true;
        // 销毁崩溃的窗口（可能已销毁，需 try-catch）
        try { win.destroy(); } catch (e) {}
        // 先设置冷却期，再走完成回调：onTaskDone 内部会触发 processNextTask，
        // 由 pauseUntil 挡住，1 秒后由下面的定时器恢复，避免毒任务崩溃风暴
        pq.pauseUntil = Date.now() + 1000;
        if (task) {
          try {
            onTaskDone(name, task.taskId, task.socketId, task.templateId, false, "渲染进程崩溃");
          } catch (err) {
            logError("printWindow-render-gone-onTaskDone", err);
          }
        }
        setTimeout(() => {
          logInfo("printWindow-render-gone", `printer="${name}" 重新处理队列，剩余=${pq.queue.length}`);
          pq.pauseUntil = 0;
          processNextTask(name);
        }, 1000);
        break;
      }
    }
  });

  // 渲染进程无响应（可能预示即将崩溃，标记并跳过该窗口的复用）
  win.webContents.on("unresponsive", () => {
    logError("printWindow-unresponsive", "渲染进程无响应，标记窗口不可复用");
    for (const [name, pq] of printerQueues) {
      if (pq.window === win) {
        pq.renderGone = true;
        break;
      }
    }
  });

  // 新窗口创建后延迟批量设置所有同名进程优先级
  setTimeout(() => {
    try {
      helper.setAllProcessesHighPriority();
    } catch (err) {
      logError("printWindow-priority", err);
    }
  }, 1000);

  let printHtml = path.join(__dirname, "../assets/print.html");
  win.loadURL("file://" + printHtml);
  return win;
}

/**
 * 确保打印机的 BrowserWindow 已创建
 * 策略：1.已有窗口直接复用 2.优先复用其他队列的空闲窗口 3.无空闲则创建新窗口
 * @returns {{ window: BrowserWindow, isNew: boolean }}
 */
function ensurePrinterWindow(printerName) {
  const pq = getPrinterQueue(printerName);

  // 1. 当前队列已有窗口，但需检查是否可继续复用
  if (pq.window && !pq.window.isDestroyed()) {
    // 渲染进程已崩溃或无响应，必须销毁重建，否则 IPC send 可能引发主进程硬崩溃
    if (pq.renderGone) {
      logInfo("ensurePrinterWindow", `printer="${printerName}" 渲染进程已崩溃，销毁旧窗口重建 reuseCount=${pq.reuseCount}`);
      try { pq.window.destroy(); } catch (e) {}
      pq.window = null;
      pq.renderGone = false;
    } else if (pq.reuseCount >= MAX_WINDOW_REUSE) {
      // 复用次数达上限，主动销毁重建，避免渲染进程内存累积导致硬崩溃
      logInfo("ensurePrinterWindow", `printer="${printerName}" 复用次数达上限(${MAX_WINDOW_REUSE})，销毁旧窗口重建`);
      try { pq.window.destroy(); } catch (e) {}
      pq.window = null;
      pq.reuseCount = 0;
    } else {
      // 窗口健康，直接复用
      if (pq.idleTimer) {
        clearTimeout(pq.idleTimer);
        pq.idleTimer = null;
      }
      logInfo("ensurePrinterWindow", `printer="${printerName}" 复用已有窗口 reuseCount=${pq.reuseCount}`);
      return { window: pq.window, isNew: false };
    }
  }

  let win = null;
  let isNew = false;

  // 2. 优先复用其他队列的空闲窗口
  win = findAndDetachIdleWindow();
  if (win) {
    logInfo("ensurePrinterWindow", `printer="${printerName}" 复用空闲窗口 活跃窗口数=${countActiveWindows() + 1}`);
    // 复用的窗口需要重新加载页面以确保干净状态
    let printHtml = path.join(__dirname, "../assets/print.html");
    win.loadURL("file://" + printHtml);
    isNew = true;
    // 复用他人窗口时重置计数
    pq.reuseCount = 0;
    pq.renderGone = false;
  } else {
    // 3. 无空闲窗口可复用，直接创建新窗口
    logInfo("ensurePrinterWindow", `printer="${printerName}" 创建新窗口 活跃窗口数=${countActiveWindows() + 1}`);
    win = createPrinterWindow();
    isNew = true;
    pq.reuseCount = 0;
    pq.renderGone = false;
  }

  win.on("closed", () => {
    logInfo("ensurePrinterWindow-closed", `printer="${printerName}" 窗口已关闭`);
    pq.window = null;
  });

  pq.window = win;
  return { window: win, isNew: isNew };
}

/**
 * 任务完成回调
 */
function onTaskDone(printerName, taskId, socketId, templateId, success, reason) {
  const pq = getPrinterQueue(printerName);

  logInfo("onTaskDone", `taskId=${taskId} printer="${printerName}" success=${success} reason="${reason || ""}"`);

  // 清除超时定时器
  if (pq.timer) {
    clearTimeout(pq.timer);
    pq.timer = null;
  }

  const socket = socketStore[socketId];
  if (socket) {
    try {
      if (success) {
        socket.emit("success", { msg: "打印成功", templateId: templateId });
      } else {
        socket.emit("error", { msg: reason || "打印失败", templateId: templateId });
      }
    } catch (err) {
      // socket 可能已断开，emit 抛异常不能影响后续流程
      logError("onTaskDone-socketEmit", err);
    }
  }

  // 持久化：任务完成，从本地文件中移除
  store.removeTask(taskId);

  pq.isPrinting = false;
  pq.currentTask = null; // 清除当前任务引用

  // 打印完成且队列已空，超过保留数量时延时回收空闲窗口
  if (pq.queue.length === 0 && pq.window && !pq.window.isDestroyed()) {
    // 清除可能存在的旧定时器
    if (pq.idleTimer) {
      clearTimeout(pq.idleTimer);
    }
    const winToClose = pq.window;
    pq.idleTimer = setTimeout(() => {
      try {
        // 回收前再次检查：活跃窗口数必须大于保留数量才回收
        if (countActiveWindows() > MIN_KEEP_WINDOWS) {
          if (!winToClose.isDestroyed()) {
            winToClose.destroy();
            console.log(`[printWindow] 空闲回收窗口 printer=${printerName} 活跃窗口数=${countActiveWindows()}`);
          }
          pq.window = null;
        } else {
          console.log(`[printWindow] 活跃窗口数=${countActiveWindows()} 未超过保留数量(${MIN_KEEP_WINDOWS})，跳过回收`);
        }
      } catch (err) {
        logError("printWindow-recycle", err);
      }
      pq.idleTimer = null;
    }, IDLE_WINDOW_TIMEOUT);
  }

  safeSendToMain("printTask", getTotalPendingCount());
  processNextTask(printerName);
}

// ========== 持久化恢复 ==========

/**
 * 从本地文件恢复未完成的任务到队列
 * 应用启动时由 main.js 在主窗口就绪后延迟调用（避免启动瞬间恢复任务触发闪退）
 *
 * 防护策略（防止缓存任务导致"启动即打印中→闪退"死循环）：
 *   1. 丢弃超过 24 小时的过期任务
 *   2. 丢弃重试次数达上限的"毒任务"（一渲染/打印就崩溃的 HTML/模板）
 *   3. 丢弃数据不完整的任务
 *   4. 单次最多恢复 MAX_RESTORE_TASKS 个，防止启动瞬间创建大量打印窗口
 *   5. 恢复的任务 retryCount+1 并写回存储，连续崩溃 3 次后自动放弃
 */
function restorePendingTasks() {
  const info = store.getStoreInfo();
  const pendingTasks = store.getPendingTasks();
  logInfo("restorePendingTasks-start", `持久化任务文件=${info.fileBytes}B 缓存任务总数=${pendingTasks.length}`);

  if (pendingTasks.length === 0) {
    return;
  }

  // ---- 第一步：过滤过期 / 毒任务 / 无效任务 ----
  const now = Date.now();
  const valid = [];
  let droppedAge = 0;
  let droppedRetry = 0;
  let droppedInvalid = 0;

  pendingTasks.forEach((t) => {
    try {
      if (now - (t.createdAt || 0) > TASK_MAX_AGE_MS) {
        droppedAge++;
        store.removeTask(t.taskId);
        return;
      }
      if ((t.retryCount || 0) >= MAX_TASK_RETRY) {
        droppedRetry++;
        store.removeTask(t.taskId);
        return;
      }
      const hasHtml = typeof t.html === "string" && t.html.length > 0;
      const hasTemplate = t.template && typeof t.template === "object";
      if (!hasHtml && !hasTemplate) {
        droppedInvalid++;
        store.removeTask(t.taskId);
        return;
      }
      valid.push(t);
    } catch (err) {
      logError("restorePendingTasks-filter", `taskId=${t.taskId} ${err.message}`);
      store.removeTask(t.taskId);
    }
  });

  if (droppedAge || droppedRetry || droppedInvalid) {
    logInfo("restorePendingTasks-filter", `过期丢弃=${droppedAge} 毒任务丢弃=${droppedRetry} 无效丢弃=${droppedInvalid} 剩余=${valid.length}`);
  }

  // ---- 第二步：只恢复最新的 N 个，其余丢弃（防启动风暴） ----
  let toRestore = valid;
  if (valid.length > MAX_RESTORE_TASKS) {
    valid.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const overflow = valid.slice(0, valid.length - MAX_RESTORE_TASKS);
    toRestore = valid.slice(valid.length - MAX_RESTORE_TASKS);
    overflow.forEach((t) => store.removeTask(t.taskId));
    logInfo("restorePendingTasks-cap", `缓存任务过多，丢弃最旧 ${overflow.length} 个，仅恢复最新 ${MAX_RESTORE_TASKS} 个`);
  }

  // 更新 taskId 计数器，避免与恢复的任务 ID 冲突
  let maxId = _taskIdCounter;
  toRestore.forEach((t) => {
    if (t.taskId > maxId) {
      maxId = t.taskId;
    }
  });
  _taskIdCounter = maxId;

  // ---- 第三步：按能否直接打印分类 ----
  const printReady = [];
  const needRender = [];

  toRestore.forEach((taskData) => {
    try {
      const printerName = taskData._resolvedPrinter || taskData.printer;
      if (!printerName) {
        store.removeTask(taskData.taskId);
        return;
      }

      // 恢复即重试：计数+1 写回存储，连续 MAX_TASK_RETRY 次失败后下次启动直接丢弃
      taskData.retryCount = (taskData.retryCount || 0) + 1;
      taskData._restored = true;
      // 旧版本持久化的任务可能带非法 copies:0（Windows DEVMODE 要求>=1），
      // 恢复路径不经过 enqueuePrintTask，必须在此归一化
      if (!taskData.copies || taskData.copies < 1) {
        taskData.copies = 1;
      }
      store.updateRetry(taskData.taskId, taskData.retryCount);

      // news-server 任务的渲染参数存的是 params，index.html 用 data.data 渲染
      if (taskData.data === undefined && taskData.params !== undefined) {
        taskData.data = taskData.params;
      }

      if (taskData.html) {
        // 已有 html，直接入打印队列
        printReady.push(taskData);
      } else if (taskData.template) {
        // 只有 template 没有 html，需要重新渲染（news-server 任务）
        needRender.push(taskData);
      } else {
        // 既没有 html 也没有 template，无法处理，移除
        store.removeTask(taskData.taskId);
      }
    } catch (err) {
      logError("restorePendingTasks-item", err);
      // 单个任务异常不影响其他任务恢复
    }
  });

  // 关键：同步刷盘 retryCount！updateRetry 是 500ms 防抖写盘，
  // 若任务在防抖窗口内把应用打崩，retryCount 永远不落盘 → 毒任务无限循环闪退。
  // 这里在开始处理任何任务之前强制同步写盘，保证最多崩溃 MAX_TASK_RETRY 次后毒任务必被丢弃
  try {
    store.flushSave();
    logInfo("restorePendingTasks-flush", `retryCount 已同步落盘（含重试计数的任务数=${printReady.length + needRender.length}）`);
  } catch (err) {
    logError("restorePendingTasks-flush", err);
  }

  // 有 html 的任务直接入打印队列
  printReady.forEach((taskData) => {
    const printerName = taskData._resolvedPrinter || taskData.printer;
    const pq = getPrinterQueue(printerName);
    pq.queue.push(taskData);
  });

  safeSendToMain("printTask", getTotalPendingCount());

  // 触发每个有任务的打印机开始处理
  // 启动时多个打印机并发处理可能同时创建多个窗口，对低内存机器冲击大
  // 改为按打印机串行启动：每个打印机间隔 500ms，给系统喘息时间
  const printersToStart = [];
  printerQueues.forEach((pq, printerName) => {
    if (pq.queue.length > 0) {
      printersToStart.push(printerName);
    }
  });

  logInfo("restorePendingTasks-start-queues", `待启动打印机数=${printersToStart.length} 直接打印=${printReady.length} 待渲染任务=${needRender.length}`);

  printersToStart.forEach((name, idx) => {
    setTimeout(() => {
      try {
        processNextTask(name);
      } catch (err) {
        logError("restorePendingTasks-processNext", `printer="${name}" ${err.message}`);
      }
    }, idx * 500);
  });

  // 需要重新渲染的任务，延迟发送 getHtml（等 MAIN_WINDOW 加载完成）
  if (needRender.length > 0) {
    logInfo("restorePendingTasks-render", `${needRender.length} 个任务需要重新渲染模板`);
    // 延迟 1.5 秒确保 MAIN_WINDOW 已加载 hiprint
    setTimeout(() => {
      needRender.forEach((taskData) => {
        try {
          // 重新设置渲染超时保护
          renderingTasks.set(taskData.taskId, {
            data: taskData,
            socketId: taskData.socketId,
            timer: setTimeout(() => {
              logError("restorePendingTasks-render-timeout", `taskId=${taskData.taskId} 渲染超时`);
              renderingTasks.delete(taskData.taskId);
              store.removeTask(taskData.taskId);
            }, RENDER_TIMEOUT),
          });
          safeSendToMain("getHtml", taskData);
        } catch (err) {
          logError("restorePendingTasks-render-item", `taskId=${taskData.taskId} ${err.message}`);
        }
      });
    }, 1500);
  }
}

/**
 * 将内存中所有未完成任务持久化
 * 应用关闭前调用，使用批量写入避免多次 IO 导致退出超时被系统强杀
 */
function flushPendingTasks() {
  const allTasks = [];

  // 收集所有队列中的任务
  printerQueues.forEach((pq) => {
    // 正在打印的任务也要写入（下次启动会重试）
    if (pq.isPrinting && pq.currentTask) {
      allTasks.push(pq.currentTask);
    }
    pq.queue.forEach((data) => {
      allTasks.push(data);
    });
  });

  // 渲染中的任务也要写入（下次启动会重试渲染）
  renderingTasks.forEach((rendering) => {
    clearTimeout(rendering.timer);
    allTasks.push(rendering.data);
  });
  renderingTasks.clear();

  // 一次性批量写入，避免多次 read-modify-write
  store.saveAllTasks(allTasks);
  // 确保防抖的写入立即落地
  if (store.flushSave) {
    store.flushSave();
  }
}

// ========== 看门狗（保活 + 运行时诊断日志） ==========

/**
 * 启动运行时看门狗：
 * 1. 每 10 秒记录心跳日志：主进程内存(rss/heap/external)、待打印任务数、
 *    打印窗口数、事件循环延迟（延迟过大即"无响应"的直接证据）
 * 2. 每 60 秒记录一次 app.getAppMetrics()：每个进程的类型/PID/CPU/内存，
 *    用于定位"哪个进程无响应/占用高"（应用正常就有 7~8 个进程）
 * 3. 内存保护：超过告警阈值回收空闲打印窗口；超过危险阈值
 *    持久化任务后 app.relaunch 自动重启（保活，防 OOM 闪退）
 */
let _watchdogStarted = false;
function startWatchdog() {
  if (_watchdogStarted) return;
  _watchdogStarted = true;

  let _lastTick = Date.now();
  let _metricsCount = 0;

  const tick = () => {
    try {
      const now = Date.now();
      // 事件循环延迟 = 实际间隔 - 定时周期，若主进程被同步 IO/execSync 卡住会显著增大
      const lag = Math.max(0, now - _lastTick - WATCHDOG_INTERVAL);
      _lastTick = now;

      const m = process.memoryUsage();
      const pending = getTotalPendingCount();
      const windows = countActiveWindows();
      const line = `rss=${Math.round(m.rss / 1048576)}MB heap=${Math.round(m.heapUsed / 1048576)}/${Math.round(m.heapTotal / 1048576)}MB external=${Math.round(m.external / 1048576)}MB 待打印=${pending} 打印窗口=${windows} 事件循环延迟=${lag}ms`;

      if (lag > EVENTLOOP_LAG_ALERT) {
        // 主进程被阻塞（同步 IO/优先级抢占等），这是任务管理器"无响应"的直接证据
        logError("watchdog-eventloop", `主进程阻塞 ${lag}ms（疑似无响应） ${line}`);
      } else {
        logInfo("watchdog-heartbeat", line);
      }

      // 每 6 个周期（约 60s）输出一次全部子进程的 CPU/内存快照
      if (++_metricsCount >= 6) {
        _metricsCount = 0;
        try {
          const metrics = app.getAppMetrics();
          const parts = metrics.map(
            (x) => `${x.type}#${x.pid} cpu=${x.cpu.percentCPUUsage.toFixed(1)}% mem=${Math.round(x.memory.workingSetSize / 1024)}MB`
          );
          logInfo("watchdog-metrics", `进程数=${metrics.length} ${parts.join(" | ")}`);
        } catch (e) {
          logError("watchdog-metrics", e);
        }
      }

      // 内存保护：先回收空闲窗口，仍超危险阈值则保活重启
      if (m.rss > MEM_CRITICAL_BYTES) {
        logError("watchdog-memory-critical", `rss=${Math.round(m.rss / 1048576)}MB 超过临界值(${Math.round(MEM_CRITICAL_BYTES / 1048576)}MB)，持久化任务后自动重启应用（保活）`);
        flushPendingTasks();
        app.relaunch();
        app.exit(1);
        return;
      }
      if (m.rss > MEM_WARN_BYTES) {
        logError("watchdog-memory-warn", `rss=${Math.round(m.rss / 1048576)}MB 超过告警值(${Math.round(MEM_WARN_BYTES / 1048576)}MB)，主动回收空闲打印窗口`);
        printerQueues.forEach((pq, name) => {
          if (pq.window && !pq.window.isDestroyed() && !pq.isPrinting && pq.queue.length === 0) {
            try {
              pq.window.destroy();
            } catch (e) { /* 忽略销毁异常 */ }
            pq.window = null;
            if (pq.idleTimer) {
              clearTimeout(pq.idleTimer);
              pq.idleTimer = null;
            }
            logInfo("watchdog-memory-recycle", `printer="${name}" 空闲窗口已回收`);
          }
        });
      }
    } catch (err) {
      logError("watchdog", err);
    }
  };

  // 关键：立即执行第一次心跳！
  // 闪退多发生在启动后 5~8 秒（恢复任务→渲染→打印），若第一个心跳等到 10 秒后，
  // 崩溃时一条看门狗日志都没有，看起来就像"看门狗没工作"。
  // 立即执行保证启动瞬间就有基线日志，之后每 10 秒一次
  tick();
  setInterval(tick, WATCHDOG_INTERVAL);
}

// ========== 托盘 ==========
async function initTray() {
  let trayPath = path.join(__dirname, "../assets/icons/tray.png");
  APP_TRAY = new Tray(trayPath);
  APP_TRAY.setToolTip("hiprint");

  // 构建托盘菜单（每次打开时动态刷新开机启动状态）
  function buildTrayMenu() {
    let trayMenuTemplate = [
      {
        label: "开机启动",
        type: "checkbox",
        checked: global.AUTO_START || false,
        click: (menuItem) => {
          // 切换开机启动状态
          const { app } = require("electron");
          try {
            app.setLoginItemSettings({
              openAtLogin: menuItem.checked,
              openAsHidden: true,
              args: ["--hidden"],
            });
            global.AUTO_START = menuItem.checked;
            // 持久化用户选择，重启后记住配置
            saveConfig("autoStart", menuItem.checked);
            // 通知页面更新显示
            safeSendToMain("autoStartStatus", menuItem.checked);
            console.log(`[autoLaunch] 开机启动已${menuItem.checked ? "开启" : "关闭"}`);
            // 重建菜单以更新勾选状态
            APP_TRAY.setContextMenu(Menu.buildFromTemplate(buildTrayMenu()));
          } catch (err) {
            helper.logError("tray-autoLaunch", err);
          }
        },
      },
      {
        label: "进程保活（计划任务）",
        type: "checkbox",
        checked: global.KEEPALIVE_ENABLED || false,
        visible: process.platform === "win32",
        click: (menuItem) => {
          const keepalive = require("./keepalive");
          try {
            if (menuItem.checked) {
              keepalive.register();
            } else {
              keepalive.unregister();
            }
            global.KEEPALIVE_ENABLED = menuItem.checked;
            // 持久化用户选择，重启后记住配置
            saveConfig("keepAlive", menuItem.checked);
            // 通知页面更新显示
            safeSendToMain("keepaliveStatus", menuItem.checked);
            logInfo("tray-keepalive", `外部保活(计划任务)已${menuItem.checked ? "开启" : "关闭"}`);
          } catch (err) {
            // 注册失败（如域策略限制），回退勾选状态
            menuItem.checked = !menuItem.checked;
            global.KEEPALIVE_ENABLED = menuItem.checked;
            logError("tray-keepalive", err);
          }
          // 重建菜单以更新勾选状态
          APP_TRAY.setContextMenu(Menu.buildFromTemplate(buildTrayMenu()));
        },
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          flushPendingTasks(); // 退出前持久化未完成任务
          // 用户主动退出：写优雅退出标记，外部保活计划任务检测到后不再拉起
          // （闪退/被杀不会走这里，无标记 → 一分钟内被计划任务自动拉起）
          try {
            require("./keepalive").markGracefulExit();
          } catch (err) {
            helper.logError("keepalive-mark-exit", err);
          }
          if (MAIN_WINDOW && !MAIN_WINDOW.isDestroyed()) {
            MAIN_WINDOW.destroy();
          }
          APP_TRAY.destroy();
          helper.appQuit();
        },
      },
    ];
    return trayMenuTemplate;
  }

  const contextMenu = Menu.buildFromTemplate(buildTrayMenu());
  APP_TRAY.setContextMenu(contextMenu);
  APP_TRAY.on("click", function() {
    if (!MAIN_WINDOW || MAIN_WINDOW.isDestroyed()) return;
    if (MAIN_WINDOW.isMinimized()) {
      MAIN_WINDOW.restore();
    }
    if (!MAIN_WINDOW.isVisible()) {
      MAIN_WINDOW.show();
      MAIN_WINDOW.setSkipTaskbar(true);
    }
  });
  return APP_TRAY;
}

// ========== Socket.IO ==========
let socketList = [];
async function initSocketIo() {
  io.on("connection", (client) => {
    socketList = [];
    socketStore[client.id] = client;
    logInfo("socket-connection", `client.id=${client.id} 当前连接数=${Object.keys(socketStore).length}`);
    client.emit("printerList", safeGetPrinters());
    client.on("news", (data) => {
      try {
        logInfo("socket-news-recv", `client.id=${client.id} printer="${data && data.printer}" templateId=${data && data.templateId} htmlLen=${data && data.html ? data.html.length : 0} copies=${data && data.copies} preview=${truncateForLog(data && data.html, 200)}`);
        if (data && data.html) {
          data.printer = data.printer;
          data.socketId = client.id;
          enqueuePrintTask(data);
        } else {
          logError("socket-news-invalid", `client.id=${client.id} 数据缺少 html 字段`);
        }
      } catch (err) {
        logError("socket-news", err);
      }
    });
    // 从服务端非前端（先持久化再渲染，防止中间环节丢失）
    client.on("news-server", (data) => {
      logInfo("socket-news-server-recv", `client.id=${client.id} data="${data}"`);
      try {
        try {
          data = JSON.parse(data);
        } catch (e) {
          data = data;
        }
        data.socketId = client.id;
        logInfo("socket-news-server-recv", `client.id=${client.id} printer="${data.printer}" templateId=${data.templateId} templateLen=${data.template ? JSON.stringify(data.template).length : 0} params=${truncateForLog(data.params, 1000)}` );

        // 先分配 taskId 并持久化，确保任务不丢失
        const taskId = nextTaskId();
        data.taskId = taskId;
        data._resolvedPrinter = data.printer;
        // 标记为渲染中状态（还未生成 html）
        store.addTask({ ...data, status: "rendering" });

        // 记录渲染中的任务，用于超时保护
        renderingTasks.set(taskId, {
          data: data,
          socketId: client.id,
          timer: setTimeout(() => {
            logError("newsServer-render-timeout", `taskId=${taskId} 模板渲染超时`);
            renderingTasks.delete(taskId);
            store.removeTask(taskId);
            try {
              const socket = socketStore[client.id];
              if (socket) {
                socket.emit("error", { msg: "模板渲染超时", templateId: data.templateId });
              }
            } catch (emitErr) {
              logError("newsServer-timeoutEmit", emitErr);
            }
          }, RENDER_TIMEOUT),
        });

        safeSendToMain("getHtml", data);
      } catch (err) {
        logError("socket-news-server", err);
      }
    });
    // 刷新打印机列表
    client.on("refreshPrinterList", (data) => {
      try {
        logInfo("socket-refreshPrinterList-recv", `client.id=${client.id}`);
        client.emit("printerList", safeGetPrinters());
      } catch (err) {
        logError("socket-refreshPrinterList", err);
      }
    });
    // 获取IP、IPV6、MAC地址、DNS
    client.on("address", (type, ...args) => {
      logInfo("socket-address-recv", `client.id=${client.id} type=${type}`);
      switch (type) {
        case "ip":
          client.emit("address", type, address.ip());
          break;
        case "ipv6":
          client.emit("address", type, address.ipv6());
          break;
        case "mac":
          address.mac(function(err, addr) {
            client.emit("address", type, addr, err);
          });
          break;
        case "dns":
          address.dns(function(err, addr) {
            client.emit("address", type, addr, err);
          });
          break;
        case "interface":
          client.emit("address", type, address.interface(...args));
          break;
        case "all":
          address(function(err, addr) {
            client.emit("address", type, addr, err);
          });
          break;
        case "vboxnet":
          address("vboxnet", function(err, addr) {
            client.emit("address", type, addr, err);
          });
        default:
          address("all", function(err, addr) {
            client.emit("address", type, addr, err);
          });
          break;
      }
    });
    // ipp打印
    client.on("ippPrint", (options) => {
      try {
        const { url, opt, action, message } = options;
        logInfo("socket-ippPrint-recv", `client.id=${client.id} action=${action} url=${url} opt=${truncateForLog(opt, 200)} message=${truncateForLog(message, 300)}`);
        let printer = ipp.Printer(url, opt);
        client.emit("ippPrinterConnected", printer);
        let msg = Object.assign(
          {
            "operation-attributes-tag": {
              "requesting-user-name": "hiPrint",
            },
          },
          message
        );
        if (msg.data && !Buffer.isBuffer(msg.data)) {
          if ("string" == typeof msg.data) {
            msg.data = Buffer.from(msg.data, msg.encoding || "utf-8");
          } else {
            msg.data = Buffer.from(msg.data);
          }
        }
        printer.execute(action, msg, (err, res) => {
          try {
            client.emit(
              "ippPrinterCallback",
              err ? { type: err.name, msg: err.message } : null,
              res
            );
          } catch (emitErr) {
            logError("ippPrint-callback-emit", emitErr);
          }
        });
      } catch (err) {
        try {
          client.emit("ippPrinterCallback", {
            type: err.name || "Error",
            msg: err.message || "IPP打印异常",
          });
        } catch (emitErr) {
          logError("ippPrint-emit", emitErr);
        }
        logError("ippPrint", err);
      }
    });
    // ipp request
    client.on("ippRequest", (options) => {
      try {
        const { url, data } = options;
        logInfo("socket-ippRequest-recv", `client.id=${client.id} url=${url} dataLen=${data ? data.length : 0} dataPreview=${truncateForLog(data, 200)}`);
        let _data = ipp.serialize(data);
        ipp.request(url, _data, function(err, res) {
          try {
            client.emit(
              "ippRequestCallback",
              err ? { type: err.name, msg: err.message } : null,
              res
            );
          } catch (emitErr) {
            logError("ippRequest-callback-emit", emitErr);
          }
        });
      } catch (err) {
        try {
          client.emit("ippRequestCallback", {
            type: err.name || "Error",
            msg: err.message || "IPP请求异常",
          });
        } catch (emitErr) {
          logError("ippRequest-emit", emitErr);
        }
        logError("ippRequest", err);
      }
    });
    // 断开连接
    client.on("disconnect", (reason) => {
      logInfo("socket-disconnect", `client.id=${client.id} reason=${reason} 剩余连接数=${Object.keys(socketStore).length - 1}`);
      delete socketStore[client.id];
      socketList = [];
      Object.keys(socketStore).forEach((key) => {
        socketStore[key].connected && socketList.push(key);
      });
      safeSendToMain("connection", socketList);
    });
    Object.keys(socketStore).forEach((key) => {
      socketStore[key].connected && socketList.push(key);
    });
    safeSendToMain("connection", socketList);
  });
  server.listen(17521);
  // 端口监听错误通过事件触发，try-catch 无法捕获
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error("[socket] 端口 17521 已被占用，请检查是否有其他实例运行");
    } else {
      console.error("[socket] 服务启动失败:", error.message);
    }
  });
}

// ========== 打印事件 ==========
function initPrintEvent() {
  ipcMain.on("do", (event, data) => {
    try {
      const printerName = data._resolvedPrinter || data.printer;
      logInfo("ipc-do-recv", `taskId=${data.taskId} printer="${printerName}" copies=${data.copies || 1} silent=${data.silent ?? true}`);
      const pq = getPrinterQueue(printerName);
      const win = pq.window;

      if (!win || win.isDestroyed()) {
        onTaskDone(printerName, data.taskId, data.socketId, data.templateId, false, "打印窗口异常");
        return;
      }

      const printers = win.webContents.getPrinters();
      let havePrinter = false;
      let defaultPrinter = "";
      printers.forEach((element) => {
        if (element.name === printerName) {
          havePrinter = true;
        }
        if (element.isDefault) {
          defaultPrinter = element.name;
        }
      });
      let deviceName = havePrinter ? printerName : defaultPrinter;

      // 检查 webContents 是否仍可用
      if (!win.webContents || win.webContents.isDestroyed()) {
        onTaskDone(printerName, data.taskId, data.socketId, data.templateId, false, "打印窗口已销毁");
        return;
      }
      // 渲染进程已崩溃但窗口对象尚未销毁的中间态：此时调用 print 是
      // Electron 13 已知的主进程硬崩溃点，必须先拦截
      if (win.webContents.isCrashed()) {
        onTaskDone(printerName, data.taskId, data.socketId, data.templateId, false, "打印窗口渲染进程已崩溃");
        return;
      }

      // copies 归一化：0/负数是非法值（Windows DEVMODE.dmCopies 必须>=1），
      // 某些打印机驱动收到非法 copies 会直接崩溃渲染进程甚至整个应用。
      // 实测缓存任务里出现过 copies: 0
      const copies = data.copies && data.copies > 0 ? Math.floor(data.copies) : 1;

      // 打印参数快照（打印前最后一条日志，闪退时它就是崩溃点的前一刻）
      logInfo(
        "ipc-do-print",
        `taskId=${data.taskId} deviceName="${deviceName}" copies=${copies} silent=${data.silent ?? true} pageSize=${data.pageSize ?? "默认"}`
      );
      flushLogs();

      win.webContents.print(
        {
          silent: data.silent ?? true,
          printBackground: data.printBackground ?? true,
          deviceName: deviceName,
          color: data.color ?? true,
          margins: data.margins ?? {
            marginType: "none",
          },
          landscape: data.landscape ?? false,
          scaleFactor: data.scaleFactor ?? 100,
          pagesPerSheet: data.pagesPerSheet ?? 1,
          collate: data.collate ?? true,
          copies: copies,
          pageRanges: data.pageRanges ?? {},
          duplexMode: data.duplexMode,
          dpi: data.dpi,
          header: data.header,
          footer: data.footer,
          pageSize: data.pageSize,
        },
        (success, failureReason) => {
          try {
            onTaskDone(printerName, data.taskId, data.socketId, data.templateId, success, failureReason);
          } catch (err) {
            logError("print-callback", err);
          }
        }
      );
    } catch (err) {
      logError("ipcMain-do", err);
      // 异常时也要通知任务完成，避免队列卡死
      const printerName = data._resolvedPrinter || data.printer;
      onTaskDone(printerName, data.taskId, data.socketId, data.templateId, false, "打印异常: " + err.message);
    }
  });

  // 收到 UI 给的 html 代码（news-server 渲染完成后回调）
  ipcMain.on("htmlPrint", (event, data) => {
    try {
      logInfo("ipc-htmlPrint-recv", `taskId=${data.taskId} printer="${data.printer}" templateId=${data.templateId} htmlLen=${data.html ? data.html.length : 0} htmlPreview=${truncateForLog(data.html, 200)}`);
      if (data && data.html) {
        // 清除渲染超时定时器
        const rendering = renderingTasks.get(data.taskId);
        if (rendering) {
          clearTimeout(rendering.timer);
          renderingTasks.delete(data.taskId);
        }
        data.printer = data.printer;
        enqueuePrintTask(data);
      }
    } catch (err) {
      logError("ipcMain-htmlPrint", err);
    }
  });

  // 模板渲染失败回调
  ipcMain.on("htmlPrintError", (event, data) => {
    try {
      logInfo("ipc-htmlPrintError-recv", `taskId=${data.taskId} templateId=${data.templateId} renderError=${data.renderError}`);
      // 清除渲染超时定时器
      const rendering = renderingTasks.get(data.taskId);
      if (rendering) {
        clearTimeout(rendering.timer);
        renderingTasks.delete(data.taskId);
      }
      // 从持久化中移除
      store.removeTask(data.taskId);
      // 通知客户端渲染失败
      const socket = socketStore[data.socketId];
      if (socket) {
        try {
          socket.emit("error", {
            msg: data.renderError || "模板渲染失败",
            templateId: data.templateId,
          });
        } catch (emitErr) {
          logError("htmlPrintError-emit", emitErr);
        }
      }
    } catch (err) {
      logError("ipcMain-htmlPrintError", err);
    }
  });
}

module.exports = async () => {
  // 初始化托盘
  await initTray();
  // 初始化socket.io
  await initSocketIo();
  // 初始化打印事件
  initPrintEvent();
  // 启动运行时看门狗（心跳日志/进程快照/内存保护/保活重启）
  startWatchdog();
  // 注意：restorePendingTasks 不在此处调用！
  // 由 main.js 在主窗口 dom-ready 后延迟 3 秒调用：
  // 旧逻辑在主窗口尚未渲染完成（打印机列表为空、进程仍在堆积）时立即恢复任务，
  // 是"刚启动就显示打印中→闪退"的诱因之一
};

// 导出持久化方法供 main.js 在关闭前调用
module.exports.flushPendingTasks = flushPendingTasks;
// 导出任务恢复方法供 main.js 在主窗口就绪后延迟调用
module.exports.restorePendingTasks = restorePendingTasks;
