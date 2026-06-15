"use strict";

const { app, BrowserWindow, ipcMain, Tray, Menu } = require("electron");
const path = require("path");
const helper = require("./helper");
const address = require("address");
const ipp = require("ipp");

// ========== 严格串行打印队列 ==========
// 替代 concurrent-tasks，避免 taskId 重复导致队列卡死

// 自增任务ID（解决时间戳并发重复问题）
let _taskIdCounter = 0;
function nextTaskId() {
  return ++_taskIdCounter;
}

// 任务队列
const printQueue = [];
// 是否正在处理任务
let isPrinting = false;
// 任务超时时间（毫秒），防止卡死
const TASK_TIMEOUT = 30000;
// 当前超时定时器
let _currentTimer = null;

/**
 * 将打印任务加入队列并尝试执行
 * @param {Object} data - 打印数据
 * @param {string} data.socketId - socket客户端ID
 * @param {string} data.html - 打印HTML内容
 */
function enqueuePrintTask(data) {
  const taskId = nextTaskId();
  data.taskId = taskId;
  printQueue.push(data);
  MAIN_WINDOW.webContents.send("printTask", printQueue.length);
  processNextTask();
}

/**
 * 处理队列中的下一个任务
 * 严格串行：只有当前任务完成后才会处理下一个
 */
function processNextTask() {
  if (isPrinting || printQueue.length === 0) {
    return;
  }
  isPrinting = true;
  const data = printQueue.shift();

  // 超时保护：防止打印回调永远不触发导致队列卡死
  _currentTimer = setTimeout(() => {
    console.error(`[print] 任务超时 taskId=${data.taskId}`);
    onTaskDone(data.taskId, data.socketId, data.templateId, false, "打印超时");
  }, TASK_TIMEOUT);

  PRINT_WINDOW.webContents.send("print-new", data);
}

/**
 * 任务完成回调
 * @param {number} taskId - 任务ID
 * @param {string} socketId - socket客户端ID
 * @param {string} templateId - 模板ID
 * @param {boolean} success - 是否成功
 * @param {string} reason - 失败原因
 */
function onTaskDone(taskId, socketId, templateId, success, reason) {
  // 清除超时定时器
  if (_currentTimer) {
    clearTimeout(_currentTimer);
    _currentTimer = null;
  }

  const socket = socketStore[socketId];
  if (socket) {
    if (success) {
      socket.emit("success", { msg: "打印成功", templateId: templateId });
    } else {
      socket.emit("error", { msg: reason || "打印失败", templateId: templateId });
    }
  }

  isPrinting = false;
  MAIN_WINDOW.webContents.send("printTask", printQueue.length);
  // 继续处理下一个任务
  processNextTask();
}

// 托盘
async function initTray() {
  let trayPath = path.join(app.getAppPath(), "/assets/icons/tray.png");
  APP_TRAY = new Tray(trayPath);
  APP_TRAY.setToolTip("hiprint"); // 托盘标题
  // 托盘菜单
  let trayMenuTemplate = [
    {
      label: "退出",
      click: () => {
        MAIN_WINDOW.destroy();
        APP_TRAY.destroy();
        helper.appQuit();
      },
    },
  ];
  const contextMenu = Menu.buildFromTemplate(trayMenuTemplate);
  APP_TRAY.setContextMenu(contextMenu);
  // 监听点击事件
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

// 初始化socket.io
let socketList = [];
async function initSocketIo() {
  io.on("connection", (client) => {
    socketList = [];
    // 暂存客户端
    socketStore[client.id] = client;
    // data:{printer:option.printer,html:htmlstr}
    client.emit("printerList", MAIN_WINDOW.webContents.getPrinters());
    client.on("news", (data) => {
      if (data && data.html) {
        data.printer = data.printer;
        data.socketId = client.id;
        enqueuePrintTask(data);
      }
    });
    // 从服务端非前端
     client.on("news-server", (data) => {
      try {
        data = JSON.parse(data);
      } catch (e) { 
        data = data;
      }
           data.socketId = client.id;
       // 生成html 
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
    // ipp打印 详见：https://www.npmjs.com/package/ipp
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
        // data 必须是 Buffer
        if (msg.data && !Buffer.isBuffer(msg.data)) {
          if ("string" == typeof msg.data) {
            msg.data = Buffer.from(msg.data, msg.encoding || "utf-8");
          } else {
            msg.data = Buffer.from(msg.data);
          }
        }
        /**
         * action: Get-Printer-Attributes 获取打印机支持参数
         * action: Print-Job 新建打印任务
         * action: Cancel-Job 取消打印任务
         */
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
      // 删除断开连接的客户端
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
    // 向主页面发送 connection 事件
    MAIN_WINDOW.webContents.send("connection", socketList);
  });
  try {
    server.listen(17521);
  } catch (error) {
    alert("服务已开启/端口被占用");
  }
}


async function createPrintWindow() {
  const windowOptions = {
    width: 100,
    height: 100,
    show: false,
    webPreferences: {
      contextIsolation: false, // 设置此项为false后，才可在渲染进程中使用electron api
      nodeIntegration: true,
    },
  };
  PRINT_WINDOW = new BrowserWindow(windowOptions);
  let printHtml = path.join("file://", app.getAppPath(), "/assets/print.html");
  PRINT_WINDOW.webContents.loadURL(printHtml);
  // PRINT_WINDOW.webContents.openDevTools();
  initPrintEvent();
}

function initPrintEvent() {
  ipcMain.on("do", (event, data) => {
    const printers = PRINT_WINDOW.webContents.getPrinters();
    let havePrinter = false;
    let defaultPrinter = "";
    printers.forEach((element) => {
      if (element.name === data.printer) {
        havePrinter = true;
      }
      if (element.isDefault) {
        defaultPrinter = element.name;
      }
    });
    let deviceName = havePrinter ? data.printer : defaultPrinter;
    // 打印 详见https://www.electronjs.org/zh/docs/latest/api/web-contents
    PRINT_WINDOW.webContents.print(
      {
        silent: data.silent ?? true, // 静默打印
        printBackground: data.printBackground ?? true, // 是否打印背景
        deviceName: deviceName, // 打印机名称
        color: data.color ?? true, // 是否打印颜色
        margins: data.margins ?? {
          marginType: "none",
        }, // 边距
        landscape: data.landscape ?? false, // 是否横向打印
        scaleFactor: data.scaleFactor ?? 100, // 打印缩放比例
        pagesPerSheet: data.pagesPerSheet ?? 1, // 每张纸的页数
        collate: data.collate ?? true, // 是否排序
        copies: data.copies ?? 1, // 打印份数
        pageRanges: data.pageRanges ?? {}, // 打印页数
        duplexMode: data.duplexMode, // 打印模式 simplex,shortEdge,longEdge
        dpi: data.dpi, // 打印机DPI
        header: data.header, // 打印头
        footer: data.footer, // 打印尾
        pageSize: data.pageSize, // 打印纸张
      },
      (success, failureReason) => {
        onTaskDone(data.taskId, data.socketId, data.templateId, success, failureReason);
      }
    );
  });
  // 收到ui 给的html 代码
  ipcMain.on("htmlPrint", (event, data) => {
    if (data && data.html) {
      data.printer = data.printer;
      enqueuePrintTask(data);
    }
  });
}

module.exports = async () => {
  // 初始化托盘
  await initTray();
  // 初始化socket.io
  await initSocketIo();
  // 创建打印窗口
  await createPrintWindow();
};
