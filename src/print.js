"use strict";

const { app, BrowserWindow, ipcMain, Tray, Menu } = require("electron");
const path = require("path");
const helper = require("./helper");
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

// 打印机队列映射表
// key: 打印机名称, value: { queue: [], isPrinting: boolean, window: BrowserWindow|null, timer: NodeJS.Timeout|null }
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
      currentTask: null, // 当前正在打印的任务数据
      window: null,
      timer: null,
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
 */
function resolvePrinterName(requestedPrinter) {
  const printers = MAIN_WINDOW.webContents.getPrinters();
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

  const pq = getPrinterQueue(printerName);
  pq.queue.push(data);

  // 持久化：news-server 已在渲染前写入，这里只对 news 接口写入
  if (!renderingTasks.has(data.taskId)) {
    store.addTask(data);
  }

  MAIN_WINDOW.webContents.send("printTask", getTotalPendingCount());
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

  pq.isPrinting = true;
  const data = pq.queue.shift();
  pq.currentTask = data; // 记录当前正在打印的任务

  // 持久化：标记为打印中
  store.markPrinting(data.taskId);

  // 超时保护
  pq.timer = setTimeout(() => {
    console.error(`[print] 任务超时 taskId=${data.taskId} printer=${printerName}`);
    onTaskDone(printerName, data.taskId, data.socketId, data.templateId, false, "打印超时");
  }, TASK_TIMEOUT);

  // 确保窗口已创建并等待加载完成
  const { window: win, isNew } = ensurePrinterWindow(printerName);

  const sendPrintNew = () => {
    win.webContents.send("print-new", data);
  };

  if (isNew) {
    // 使用 once 避免重复监听
    win.webContents.once("dom-ready", sendPrintNew);
  } else {
    sendPrintNew();
  }
}

/**
 * 确保打印机的 BrowserWindow 已创建
 * @returns {{ window: BrowserWindow, isNew: boolean }}
 */
function ensurePrinterWindow(printerName) {
  const pq = getPrinterQueue(printerName);
  if (pq.window && !pq.window.isDestroyed()) {
    return { window: pq.window, isNew: false };
  }

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
  // 打包后 app.getAppPath() 返回 .asar 路径，Electron 能自动处理 asar 内文件读取
  // 但为兼容性考虑，使用 __dirname 构建路径更可靠
  let printHtml = path.join(__dirname, "../assets/print.html");
  win.loadURL("file://" + printHtml);

  win.on("closed", () => {
    pq.window = null;
  });

  pq.window = win;
  return { window: win, isNew: true };
}

/**
 * 任务完成回调
 */
function onTaskDone(printerName, taskId, socketId, templateId, success, reason) {
  const pq = getPrinterQueue(printerName);

  // 清除超时定时器
  if (pq.timer) {
    clearTimeout(pq.timer);
    pq.timer = null;
  }

  const socket = socketStore[socketId];
  if (socket) {
    if (success) {
      socket.emit("success", { msg: "打印成功", templateId: templateId });
    } else {
      socket.emit("error", { msg: reason || "打印失败", templateId: templateId });
    }
  }

  // 持久化：任务完成，从本地文件中移除
  store.removeTask(taskId);

  pq.isPrinting = false;
  pq.currentTask = null; // 清除当前任务引用
  MAIN_WINDOW.webContents.send("printTask", getTotalPendingCount());
  processNextTask(printerName);
}

// ========== 持久化恢复 ==========

/**
 * 从本地文件恢复未完成的任务到队列
 * 应用启动时调用
 */
function restorePendingTasks() {
  const pendingTasks = store.getPendingTasks();
  if (pendingTasks.length === 0) {
    return;
  }

  console.log(`[store] 恢复 ${pendingTasks.length} 个未完成任务`);

  // 更新 taskId 计数器，避免与恢复的任务 ID 冲突
  let maxId = _taskIdCounter;
  pendingTasks.forEach((t) => {
    if (t.taskId > maxId) {
      maxId = t.taskId;
    }
  });
  _taskIdCounter = maxId;

  // 分为两类：有 html 的直接入打印队列，无 html 的需要重新渲染
  const printReady = [];
  const needRender = [];

  pendingTasks.forEach((taskData) => {
    const printerName = taskData._resolvedPrinter || taskData.printer;
    if (!printerName) {
      store.removeTask(taskData.taskId);
      return;
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
  });

  // 有 html 的任务直接入打印队列
  printReady.forEach((taskData) => {
    const printerName = taskData._resolvedPrinter || taskData.printer;
    const pq = getPrinterQueue(printerName);
    pq.queue.push(taskData);
  });

  MAIN_WINDOW.webContents.send("printTask", getTotalPendingCount());

  // 触发每个有任务的打印机开始处理
  printerQueues.forEach((pq, printerName) => {
    if (pq.queue.length > 0) {
      processNextTask(printerName);
    }
  });

  // 需要重新渲染的任务，延迟发送 getHtml（等 MAIN_WINDOW 加载完成）
  if (needRender.length > 0) {
    console.log(`[store] ${needRender.length} 个任务需要重新渲染模板`);
    // 延迟 1 秒确保 MAIN_WINDOW 已加载 hiprint
    setTimeout(() => {
      needRender.forEach((taskData) => {
        // 重新设置渲染超时保护
        renderingTasks.set(taskData.taskId, {
          data: taskData,
          socketId: taskData.socketId,
          timer: setTimeout(() => {
            console.error(`[print] 恢复任务渲染超时 taskId=${taskData.taskId}`);
            renderingTasks.delete(taskData.taskId);
            store.removeTask(taskData.taskId);
          }, RENDER_TIMEOUT),
        });
        MAIN_WINDOW.webContents.send("getHtml", taskData);
      });
    }, 1000);
  }
}

/**
 * 将内存中所有未完成任务持久化
 * 应用关闭前调用
 */
function flushPendingTasks() {
  // 先清空文件（因为内存中的状态是最新的）
  store.clearAll();

  // 重新写入所有队列中的任务
  printerQueues.forEach((pq) => {
    // 正在打印的任务也要写入（下次启动会重试）
    if (pq.isPrinting && pq.currentTask) {
      store.addTask(pq.currentTask);
    }
    pq.queue.forEach((data) => {
      store.addTask(data);
    });
  });

  // 渲染中的任务也要写入（下次启动会重试渲染）
  renderingTasks.forEach((rendering) => {
    clearTimeout(rendering.timer);
    store.addTask(rendering.data);
  });
  renderingTasks.clear();
}

// ========== 托盘 ==========
async function initTray() {
  let trayPath = path.join(__dirname, "../assets/icons/tray.png");
  APP_TRAY = new Tray(trayPath);
  APP_TRAY.setToolTip("hiprint");
  let trayMenuTemplate = [
    {
      label: "退出",
      click: () => {
        flushPendingTasks(); // 退出前持久化未完成任务
        MAIN_WINDOW.destroy();
        APP_TRAY.destroy();
        helper.appQuit();
      },
    },
  ];
  const contextMenu = Menu.buildFromTemplate(trayMenuTemplate);
  APP_TRAY.setContextMenu(contextMenu);
  APP_TRAY.on("click", function() {
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
    client.emit("printerList", MAIN_WINDOW.webContents.getPrinters());
    client.on("news", (data) => {
      if (data && data.html) {
        data.printer = data.printer;
        data.socketId = client.id;
        enqueuePrintTask(data);
      }
    });
    // 从服务端非前端（先持久化再渲染，防止中间环节丢失）
    client.on("news-server", (data) => {
      try {
        data = JSON.parse(data);
      } catch (e) {
        data = data;
      }
      data.socketId = client.id;

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
          console.error(`[print] 模板渲染超时 taskId=${taskId}`);
          renderingTasks.delete(taskId);
          store.removeTask(taskId);
          const socket = socketStore[client.id];
          if (socket) {
            socket.emit("error", { msg: "模板渲染超时", templateId: data.templateId });
          }
        }, RENDER_TIMEOUT),
      });

      MAIN_WINDOW.webContents.send("getHtml", data);
    });
    // 刷新打印机列表
    client.on("refreshPrinterList", (data) => {
      client.emit("printerList", MAIN_WINDOW.webContents.getPrinters());
    });
    // 获取IP、IPV6、MAC地址、DNS
    client.on("address", (type, ...args) => {
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
          client.emit(
            "ippPrinterCallback",
            err ? { type: err.name, msg: err.message } : null,
            res
          );
        });
      } catch (err) {
        client.emit("ippPrinterCallback", {
          type: err.name,
          msg: err.message,
        });
      }
    });
    // ipp request
    client.on("ippRequest", (options) => {
      try {
        const { url, data } = options;
        let _data = ipp.serialize(data);
        ipp.request(url, _data, function(err, res) {
          client.emit(
            "ippRequestCallback",
            err ? { type: err.name, msg: err.message } : null,
            res
          );
        });
      } catch (err) {
        client.emit("ippRequestCallback", {
          type: err.name,
          msg: err.message,
        });
      }
    });
    // 断开连接
    client.on("disconnect", () => {
      delete socketStore[client.id];
      socketList = [];
      Object.keys(socketStore).forEach((key) => {
        socketStore[key].connected && socketList.push(key);
      });
      MAIN_WINDOW.webContents.send("connection", socketList);
    });
    Object.keys(socketStore).forEach((key) => {
      socketStore[key].connected && socketList.push(key);
    });
    MAIN_WINDOW.webContents.send("connection", socketList);
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
    const printerName = data._resolvedPrinter || data.printer;
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
        copies: data.copies ?? 1,
        pageRanges: data.pageRanges ?? {},
        duplexMode: data.duplexMode,
        dpi: data.dpi,
        header: data.header,
        footer: data.footer,
        pageSize: data.pageSize,
      },
      (success, failureReason) => {
        onTaskDone(printerName, data.taskId, data.socketId, data.templateId, success, failureReason);
      }
    );
  });

  // 收到 UI 给的 html 代码（news-server 渲染完成后回调）
  ipcMain.on("htmlPrint", (event, data) => {
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
  });

  // 模板渲染失败回调
  ipcMain.on("htmlPrintError", (event, data) => {
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
      socket.emit("error", {
        msg: data.renderError || "模板渲染失败",
        templateId: data.templateId,
      });
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
  // 恢复未完成的任务
  restorePendingTasks();
};

// 导出持久化方法供 main.js 在关闭前调用
module.exports.flushPendingTasks = flushPendingTasks;
