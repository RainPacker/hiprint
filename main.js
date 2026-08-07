const { app, BrowserWindow, BrowserView, ipcMain, Menu } = require("electron");

const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const server = require("http").createServer();
const helper = require("./src/helper");
const { logError } = helper;
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

// 设置进程为高优先级，确保打印任务及时响应
// Windows 优先级：32=Normal, 128=High, 256=Realtime(需管理员)
// 使用 wmic 命令设置最可靠，os.setPriority 在 Windows 上行为不一致
global.PROCESS_PRIORITY = "普通";
try {
  execSync(`wmic process where processid=${process.pid} call setpriority 128`, { stdio: "ignore" });
  global.PROCESS_PRIORITY = "高";
  console.log("[priority] 进程优先级已设置为高");
} catch (err) {
// wmic 失败则尝试 os.setPriority
  try {
    os.setPriority(process.pid, "high");
    global.PROCESS_PRIORITY = "高";
    console.log("[priority] 进程优先级已设置为高(os.setPriority)");
  } catch (err2) {
    logError("setPriority", err2);
  }
}

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
  maxHttpBufferSize: 10000000000,
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
process.on("uncaughtException", (error) => {
  logError("uncaughtException", error);
});
process.on("unhandledRejection", (reason, promise) => {
  logError("unhandledRejection", reason);
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
    // 默认开启开机启动
    setAutoLaunch(true);
    // 创建浏览器窗口
    createWindow();
    app.on("activate", function() {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
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
    server.close();
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

  MAIN_WINDOW.webContents.on("dom-ready", async (event) => {
    MAIN_WINDOW.removeBrowserView(loadingBrowserView);
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



initialize();
