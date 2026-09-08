// ============ 启动诊断（必须在最早期，捕获闪退真实原因）============
// 不依赖任何业务模块，仅用 node 内置 fs/path 同步写入
const _diagFs = require("fs");
const _diagPath = require("path");
const _diagLogPath = _diagPath.join(process.env.APPDATA || process.env.HOME || __dirname, "electron-hiprint", "diag-startup.log");
function _diagLog(msg) {
  try {
    const _dir = _diagPath.dirname(_diagLogPath);
    if (!_diagFs.existsSync(_dir)) _diagFs.mkdirSync(_dir, { recursive: true });
    _diagFs.appendFileSync(_diagLogPath, `[${new Date().toISOString()}] ${msg}\n`, "utf-8");
  } catch (e) { /* 诊断不能影响主流程 */ }
}
_diagLog("==== 诊断启动开始 ====");
_diagLog(`versions: node=${process.versions.node} electron=${process.versions.electron} chrome=${process.versions.chrome}`);
_diagLog(`env: platform=${process.platform} arch=${process.arch} cwd=${process.cwd()}`);
_diagLog(`argv: ${JSON.stringify(process.argv)}`);
_diagLog(`__dirname: ${__dirname}`);
// 捕获所有进程级退出路径，确保闪退前能留下日志
process.on("exit", (code) => _diagLog(`process.on(exit) code=${code}`));
process.on("SIGINT", () => _diagLog("process.on(SIGINT)"));
process.on("SIGTERM", () => _diagLog("process.on(SIGTERM)"));
// 定时记录内存使用，捕获内存泄漏导致闪退
let _memMonitorTimer = null;
function _startMemMonitor() {
  if (_memMonitorTimer) return;
  _memMonitorTimer = setInterval(() => {
    try {
      const m = process.memoryUsage();
      _diagLog(`[内存监控] rss=${Math.round(m.rss / 1048576)}MB heapUsed=${Math.round(m.heapUsed / 1048576)}MB heapTotal=${Math.round(m.heapTotal / 1048576)}MB external=${Math.round(m.external / 1048576)}MB`);
    } catch (e) { }
  }, 10000);
}
// 注意：不手动启动 crashReporter，Electron 打包应用默认已内置 Crashpad 崩溃捕获
// 手动调用 crashReporter.start() 在打包模式下会触发 native 崩溃

const { app, BrowserWindow, BrowserView, ipcMain, Menu } = require("electron");
_diagLog("require(electron) 完成");

const path = require("path");
const server = require("http").createServer();
const helper = require("./src/helper");
const { logError, flushLogs, cleanupOldLogs, saveConfig, getConfig, setProcessHighPriority, setAllProcessesHighPriority } = helper;
const printSetup = require("./src/print");
const address = require("address");
_diagLog("业务模块 require 完成（helper, print, address, http, socket.io 待创建）");

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
_diagLog("commandLine switches 设置完成");

// 设置主进程为高优先级，确保打印任务及时响应
global.PROCESS_PRIORITY = setProcessHighPriority(process.pid);
_diagLog(`setProcessHighPriority 完成 result=${global.PROCESS_PRIORITY}`);

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
  // 限制为 50MB，防止大 payload 导致内存溢出闪退（原500MB过大易致服务器OOM）
  maxHttpBufferSize: 5e7,
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
_diagLog("socket.io 实例创建完成");

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
_diagLog("全局异常处理器已注册（uncaughtException, unhandledRejection）");
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
  _diagLog(`requestSingleInstanceLock gotTheLock=${gotTheLock}`);
  if (!gotTheLock) {
    _diagLog("未获取单实例锁，准备退出（这可能是用户感知'闪退'的原因：已有实例在后台运行）");
    helper.appQuit();
    return;
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
    _diagLog("app.whenReady 触发，开始初始化");
    // 启动时清理过期日志（保留 60 天），异步执行不阻塞窗口创建
    try {
      cleanupOldLogs();
    } catch (err) {
      logError("startup-cleanupOldLogs", err);
      _diagLog(`cleanupOldLogs 异常: ${err.message}`);
    }
    // 读取用户上次的开机启动配置，首次启动默认开启
    const savedAutoStart = getConfig("autoStart", true);
    _diagLog(`getConfig autoStart=${savedAutoStart}`);
    setAutoLaunch(savedAutoStart);
    _diagLog("setAutoLaunch 完成");
    // 创建浏览器窗口
    createWindow();
    _diagLog("createWindow 已调用（异步执行中）");
    app.on("activate", function() {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });

    // 监听所有子进程崩溃（GPU/Renderer/Utility/Network 等）
    app.on("child-process-gone", (event, details) => {
      _diagLog(`[child-process-gone] type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
      logError("child-process-gone", `type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
    });
  });
  // 关闭了所有窗口
  app.on("window-all-closed", function() {
    _diagLog("window-all-closed 触发（所有窗口已关闭，即将退出）");
    if (process.platform !== "darwin") {
      helper.appQuit();
    }
  });
  // 应用退出前持久化未完成的打印任务
  app.on("before-quit", () => {
    _diagLog("before-quit 触发（应用即将退出）");
    if (printSetup.flushPendingTasks) {
      printSetup.flushPendingTasks();
    }
  });
  app.on("will-quit", () => _diagLog("will-quit 触发"));
  app.on("quit", (event, exitCode) => _diagLog(`quit 触发 exitCode=${exitCode}`));
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
  // 同样用 app.isPackaged 判断，避免打包后设置 asar 内无效路径导致图标加载失败警告
  if (process.platform === "win32" && !app.isPackaged) {
    windowOptions.icon = path.join(__dirname, "build/icons/256x256.png");
  }

  MAIN_WINDOW = new BrowserWindow(windowOptions);
  _diagLog("BrowserWindow 创建完成");

  // 开机启动时带 --hidden 参数，静默启动到托盘
  const startHidden = process.argv.includes("--hidden");
  _diagLog(`startHidden=${startHidden} argv含--hidden=${startHidden}`);
  if (startHidden) {
    MAIN_WINDOW.hide();
    MAIN_WINDOW.setSkipTaskbar(true);
  }

  // 白屏的问题
  await loadingView(windowOptions);
  _diagLog("loadingView 完成");
  // MAIN_WINDOW.once("ready-to-show", () => {
  //   MAIN_WINDOW.show();
  // });

  // 系统相关
  await systemSetup();
  _diagLog("systemSetup 完成");
  // 加载主页面（打包后需处理 asar 路径）
  let indexPath = path.join(__dirname, "/assets/index.html");
  _diagLog(`loadURL 开始 indexPath=${indexPath} exists=${require("fs").existsSync(indexPath.replace(/\//g, "\\"))}`);
  MAIN_WINDOW.webContents.loadURL("file://" + indexPath);

  // 主窗口 dom-ready 后批量设置所有进程优先级
  // 此时 Main/Renderer/GPU/Network/Utility 进程均已创建
  MAIN_WINDOW.webContents.once("dom-ready", () => {
    global.PROCESS_PRIORITY = setAllProcessesHighPriority();
    // 3秒后再次设置，覆盖可能延迟创建的子进程
    setTimeout(() => {
      global.PROCESS_PRIORITY = setAllProcessesHighPriority();
    }, 3000);

    // 延迟恢复未完成的打印任务：等主窗口渲染完成 + 3 秒缓冲再恢复，
    // 避免启动瞬间（打印机列表未就绪、渲染进程还在堆积）恢复缓存任务导致闪退
    // 恢复逻辑内部带有过期/毒任务/数量上限过滤（见 print.js restorePendingTasks）
    setTimeout(() => {
      try {
        _diagLog("开始恢复持久化的打印任务");
        printSetup.restorePendingTasks();
        _diagLog("restorePendingTasks 完成");
      } catch (err) {
        logError("restorePendingTasks-main", err);
        _diagLog(`restorePendingTasks 异常: ${err.message}`);
      }
    }, 3000);
  });

  // 仅在开发环境打开 DevTools
  // 必须用 app.isPackaged 判断，不能用 NODE_ENV（打包后该变量未设置，条件恒为真会导致生产环境也打开 DevTools）
  // 服务器环境（WinServer/GPU驱动不完整）下 DevTools 大量日志会导致渲染进程崩溃闪退
  if (!app.isPackaged) {
    MAIN_WINDOW.webContents.openDevTools();
  }

  // 渲染进程崩溃处理（WinServer 2025 上 GPU 兼容性可能导致崩溃）
  // 保活策略：单次崩溃自动 reload；60 秒内崩溃 3 次说明页面本身有问题，
  // 自动重启整个应用（app.relaunch），配合任务持久化实现断点续打
  let _mainRenderCrashTimes = [];
  MAIN_WINDOW.webContents.on("render-process-gone", (event, details) => {
    logError("render-process-gone", `reason=${details.reason} exitCode=${details.exitCode}`);
    const now = Date.now();
    // 只统计最近 60 秒内的崩溃
    _mainRenderCrashTimes = _mainRenderCrashTimes.filter((t) => now - t < 60000);
    _mainRenderCrashTimes.push(now);

    if (_mainRenderCrashTimes.length >= 3) {
      logError("render-process-gone-relaunch", `60秒内主窗口渲染进程已崩溃 ${_mainRenderCrashTimes.length} 次，持久化任务后自动重启应用（保活）`);
      _diagLog(`主窗口渲染进程 60 秒内崩溃 ${_mainRenderCrashTimes.length} 次，自动重启应用`);
      try {
        if (printSetup.flushPendingTasks) {
          printSetup.flushPendingTasks();
        }
      } catch (err) {
        logError("render-process-gone-flush", err);
      }
      app.relaunch();
      app.exit(1);
      return;
    }

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
  _diagLog("printSetup 开始（initTray + initSocketIo + initPrintEvent + 看门狗）");
  await printSetup();
  _diagLog("printSetup 完成（托盘/socket/打印事件/看门狗全部就绪，任务恢复延后至 dom-ready+3s）");

  // 记录当前进程快照：正常应有 7~8 个进程
  // (Main + GPU + Network + Utility + Crashpad + 主窗口Renderer + 打印窗口Renderer...)
  // 后续由 print.js 看门狗每 60 秒记录各进程 CPU/内存到 logs/crash-*.log
  try {
    const metrics = app.getAppMetrics();
    _diagLog(`进程快照 共${metrics.length}个: ${metrics.map((m) => `${m.type}#${m.pid}`).join(", ")}`);
  } catch (e) {
    _diagLog(`获取进程快照失败: ${e.message}`);
  }

  // 启动定时内存监控，捕获内存泄漏导致闪退
  const _initMem = process.memoryUsage();
  _diagLog(`[内存初始] rss=${Math.round(_initMem.rss / 1048576)}MB heapUsed=${Math.round(_initMem.heapUsed / 1048576)}MB heapTotal=${Math.round(_initMem.heapTotal / 1048576)}MB`);
  _startMemMonitor();

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
    // 延迟销毁 webContents，避免在 dom-ready 回调中立即销毁影响主窗口渲染
    // 导致 loading 动画残留与主页面同时显示
    setTimeout(() => {
      try {
        if (loadingBrowserView.webContents && !loadingBrowserView.webContents.isDestroyed()) {
          loadingBrowserView.webContents.destroy();
        }
      } catch (e) { /* 忽略销毁异常 */ }
    }, 2000);
  });
}

// 系统相关
async function systemSetup() {
  // 显示标题栏菜单
  // MAIN_WINDOW.setWindowButtonVisibility(false);
  Menu.setApplicationMenu(null);
}

// 获取设备唯一id（恢复 node-machine-id 原始机器GUID，保证与服务器端设备注册一致）
// 缓存结果：execSync 只执行一次，避免重复调用在服务器上触发 EPIPE
let _machineIdCache = null;
function getMachineIdOnce() {
  if (_machineIdCache) return _machineIdCache;
  try {
    const { machineIdSync } = require("node-machine-id");
    _machineIdCache = machineIdSync({ original: true });
  } catch (err) {
    console.error("[getMachineId] 获取机器ID失败:", err.message);
    // 回退：用主机名+MAC地址生成稳定唯一ID（不随安装路径变化）
    try {
      const os = require("os");
      const crypto = require("crypto");
      const hostname = os.hostname();
      const nets = os.networkInterfaces();
      let mac = "";
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (!net.internal && net.mac && net.mac !== "00:00:00:00:00:00") {
            mac = net.mac;
            break;
          }
        }
        if (mac) break;
      }
      _machineIdCache = "fb-" + crypto.createHash("sha256").update(hostname + mac).digest("hex");
    } catch (e) {
      _machineIdCache = app.getPath("userData").replace(/[\\\/]/g, "_");
    }
  }
  return _machineIdCache;
}

ipcMain.on("getMachineId", function (event) {
  event.sender.send("machineId", getMachineIdOnce());
});

// 获取设备ip、mac等信息
ipcMain.on("getAddress", function(event) {
  address(function(err, arg) {
    if (err || !arg) {
      arg = { ip: "127.0.0.1", mac: "unknown" };
    }
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
