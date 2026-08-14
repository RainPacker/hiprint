const { app, BrowserWindow, BrowserView, ipcMain, Menu } = require("electron");

const path = require("path");
const server = require("http").createServer();
const helper = require("./src/helper");
const { logError, flushLogs, cleanupOldLogs, saveConfig, getConfig, setProcessHighPriority, setAllProcessesHighPriority } = helper;
const printSetup = require("./src/print");
const address = require("address");

// Windows Server 缺少 GPU 驱动时，Chromium 渲染会崩溃闪退
// 必须在 app.ready 之前设置
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-software-rasterizer");
// WinServer 2025 兼容性：禁用可能不兼容的 GPU 相关特性
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-gpu-sandbox");
// 提升响应优先级：禁用后台节流，提升打印任务处理速度
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// 设置主进程为高优先级，确保打印任务及时响应
global.PROCESS_PRIORITY = setProcessHighPriority(process.pid);

// 主进程
global.MAIN_WINDOW = null;
global.APP_TRAY = null;
global.CAN_QUIT = false;

// 打印窗口
global.PRINT_WINDOW = null;

global.server = server;
const io = require("socket.io")(server, {
  pingInterval: 10000,
  pingTimeout: 5000,
  // 限制为 500MB，防止大 payload 导致内存溢出闪退
  maxHttpBufferSize: 5e8,
  allowEIO3: true, // 兼容 Socket.IO 2.x
  // 跨域问题(Socket.IO 3.x 使用这种方式)
  cors: {
    // origin: "*",
    // 兼容 Socket.IO 2.x
    origin: (requestOrigin, callback) => {
      // 允许所有域名连接
      callback(null, requestOrigin);
    },
    methods: "GET, POST, PUT, DELETE, OPTIONS",
    allowedHeaders: "*",
    // 详情参数见 https://www.npmjs.com/package/cors
    credentials: false,
  },
});
global.io = io;

global.socketStore = {};

// 全局异常捕获，防止未处理异常导致闪退，并写入崩溃日志
// 异常可能预示主进程即将退出，立即刷盘确保日志不丢失
process.on("uncaughtException", (error) => {
  logError("uncaughtException", error);
  flushLogs();
});
process.on("unhandledRejection", (reason, promise) => {
  logError("unhandledRejection", reason);
  flushLogs();
});

// ========== 开机启动 ==========
// 全局开关状态，供托盘菜单读取/切换
global.AUTO_START = false;

/**
 * 配置开机启动
 * @param {boolean} enable - 是否启用
 */
function setAutoLaunch(enable) {
  try {
    app.setLoginItemSettings({
      openAtLogin: enable,
      openAsHidden: true, // 开机启动后隐藏到托盘
      args: ["--hidden"], // 启动参数，用于静默启动
    });
    global.AUTO_START = enable;
    // 持久化用户选择，重启后读取
    saveConfig("autoStart", enable);
    console.log(`[autoLaunch] 开机启动已${enable ? "开启" : "关闭"}`);
  } catch (err) {
    logError("setAutoLaunch", err);
  }
}

/**
 * 读取当前开机启动状态
 * 直接返回 global.AUTO_START，避免 app.getLoginItemSettings() 在部分环境返回不准
 */
function getAutoLaunch() {
  return global.AUTO_START;
}

// 初始化
async function initialize() {
  // 限制一个窗口
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    helper.appQuit();
  }
  app.on("second-instance", (event) => {
    if (MAIN_WINDOW) {
      if (MAIN_WINDOW.isMinimized()) {
        MAIN_WINDOW.restore();
      }
      MAIN_WINDOW.focus();
    }
  });
  // 当electron完成初始化
  app.whenReady().then(() => {
    // 启动时清理过期日志（保留 60 天），异步执行不阻塞窗口创建
    try {
      cleanupOldLogs();
    } catch (err) {
      logError("startup-cleanupOldLogs", err);
    }
    // 读取用户上次的开机启动配置，首次启动默认开启
    const savedAutoStart = getConfig("autoStart", true);
    setAutoLaunch(savedAutoStart);
    // 创建浏览器窗口
    createWindow();
    app.on("activate", function() {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });

    // 监听所有子进程崩溃（GPU/Renderer/Utility/Network 等）
    app.on("child-process-gone", (event, details) => {
      logError("child-process-gone", `type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
    });
  });
  // 关闭了所有窗口
  app.on("window-all-closed", function() {
    if (process.platform !== "darwin") {
      helper.appQuit();
    }
  });
  // 应用退出前持久化未完成的打印任务
  app.on("before-quit", () => {
    if (printSetup.flushPendingTasks) {
      printSetup.flushPendingTasks();
    }
  });
}

// 主窗口
async function createWindow() {
  const windowOptions = {
    width: 500,
    height: 300,
    minWidth: 500,
    minHeight: 300,
    maxWidth: 500,
    maxHeight: 300,
    // titleBarStyle: "customButtonsOnHover", // 标题栏样式
    // show: false, // 不显示窗口
    // transparent: true, // 透明标题栏
    center: true, // 居中
    // alwaysOnTop: true, // 永远置顶
    // resizable: true, // 可缩放
    frame: true, // 显示边框
    webPreferences: {
      // webSecurity: false,
      contextIsolation: false, // 设置此项为false后，才可在渲染进程中使用electron api
      nodeIntegration: true,
    },
  };
  // win 左上角图标(暂处理：打包后这样设置无法显示...)
  // 若package.json 中设置 .ico 开发可显示，打包后不显示
  if (process.platform === "win32" && process.env.NODE_ENV !== "production") {
    windowOptions.icon = path.join(__dirname, "build/icons/256x256.png");
  }

  MAIN_WINDOW = new BrowserWindow(windowOptions);

  // 开机启动时带 --hidden 参数，静默启动到托盘
  const startHidden = process.argv.includes("--hidden");
  if (startHidden) {
    MAIN_WINDOW.hide();
    MAIN_WINDOW.setSkipTaskbar(true);
  }

  // 白屏的问题
  await loadingView(windowOptions);
  // MAIN_WINDOW.once("ready-to-show", () => {
  //   MAIN_WINDOW.show();
  // });

  // 系统相关
  await systemSetup();
  // 加载主页面（打包后需处理 asar 路径）
  let indexPath = path.join(__dirname, "/assets/index.html");
  MAIN_WINDOW.webContents.loadURL("file://" + indexPath);

  // 主窗口 dom-ready 后批量设置所有进程优先级
  // 此时 Main/Renderer/GPU/Network/Utility 进程均已创建
  MAIN_WINDOW.webContents.once("dom-ready", () => {
    global.PROCESS_PRIORITY = setAllProcessesHighPriority();
    // 3秒后再次设置，覆盖可能延迟创建的子进程
    setTimeout(() => {
      global.PROCESS_PRIORITY = setAllProcessesHighPriority();
    }, 3000);
  });

  // 仅在开发环境打开 DevTools，生产环境打开可能导致 WinServer 渲染异常
  if (process.env.NODE_ENV !== "production") {
    MAIN_WINDOW.webContents.openDevTools();
  }

  // 渲染进程崩溃处理（WinServer 2025 上 GPU 兼容性可能导致崩溃）
  MAIN_WINDOW.webContents.on("render-process-gone", (event, details) => {
    logError("render-process-gone", `reason=${details.reason} exitCode=${details.exitCode}`);
    // 尝试重新加载页面恢复
    try {
      if (!MAIN_WINDOW.isDestroyed()) {
        MAIN_WINDOW.webContents.reload();
      }
    } catch (err) {
      logError("render-process-gone-reload", err);
    }
  });

  // GPU 进程崩溃处理
  app.on("gpu-process-crashed", (event) => {
    logError("gpu-process-crashed", "GPU 进程崩溃");
  });

  // 退出
  MAIN_WINDOW.on("closed", () => {
    MAIN_WINDOW = null;
    // 仅在真正退出时关闭 server，避免托盘模式下重复调用
    try {
      if (global.server && global.server.listening) {
        global.server.close();
      }
    } catch (err) {
      logError("server-close", err);
    }
  });
  // 点击关闭，最小化到托盘
  MAIN_WINDOW.on("close", (event) => {
    if (!CAN_QUIT && MAIN_WINDOW && !MAIN_WINDOW.isDestroyed()) {
      MAIN_WINDOW.hide();
      MAIN_WINDOW.setSkipTaskbar(true); // 隐藏任务栏
      event.preventDefault();
    }
  });
  // 打印相关
  await printSetup();

  return MAIN_WINDOW;
}

// 加载等待页面
async function loadingView(windowOptions) {
  const loadingBrowserView = new BrowserView();
  MAIN_WINDOW.setBrowserView(loadingBrowserView);
  loadingBrowserView.setBounds({
    x: 0,
    y: 0,
    width: windowOptions.width,
    height: windowOptions.height,
  });

  const loadingHtml = path.join(__dirname, "/assets/loading.html");
  loadingBrowserView.webContents.loadURL("file://" + loadingHtml);

  // 使用 once 避免重复触发，添加销毁检查
  MAIN_WINDOW.webContents.once("dom-ready", async (event) => {
    try {
      if (!MAIN_WINDOW.isDestroyed()) {
        MAIN_WINDOW.removeBrowserView(loadingBrowserView);
      }
    } catch (err) {
      logError("loadingView-remove", err);
    }
  });
}

// 系统相关
async function systemSetup() {
  // 显示标题栏菜单
  // MAIN_WINDOW.setWindowButtonVisibility(false);
  Menu.setApplicationMenu(null);
}

// 获取设备唯一id
ipcMain.on("getMachineId", function(event) {
  try {
    const { machineIdSync } = require("node-machine-id");
    event.sender.send("machineId", machineIdSync({ original: true }));
  } catch (err) {
    console.error("[getMachineId] 获取机器ID失败:", err.message);
    // 回退：使用用户数据目录路径作为简易唯一标识
    event.sender.send("machineId", app.getPath("userData").replace(/[\\\/]/g, "_"));
  }
});

// 获取设备ip、mac等信息
ipcMain.on("getAddress", function(event) {
  address(function(err, arg) {
    event.sender.send("address", arg);
  });
});

// 获取开机启动状态
ipcMain.on("getAutoStartStatus", function (event) {
  event.sender.send("autoStartStatus", getAutoLaunch());
});

// 获取进程优先级
ipcMain.on("getProcessPriority", function (event) {
  event.sender.send("processPriority", global.PROCESS_PRIORITY || "普通");
});

// 获取应用版本号
ipcMain.on("getAppVersion", function (event) {
  event.sender.send("appVersion", app.getVersion());
});



initialize();
