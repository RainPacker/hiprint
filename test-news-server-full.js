/**
 * news-server 完整场景测试脚本
 *
 * 使用方法：
 *   1. 先启动 electron-hiprint 应用（npm start）
 *   2. 再运行本脚本：node test-news-server-full.js
 *   3. 可选参数：
 *      --persistence  仅测试持久化文件验证（不发打印，只检查文件）
 *      --crash        模拟崩溃恢复测试（发送任务后立即断开，检查文件）
 *
 * 测试场景：
 *   场景1: 正常 news-server 任务（模板渲染 → 打印 → 回调）
 *   场景2: 无效模板（渲染异常 → error 回调）
 *   场景3: 并发 news-server 任务（5个同时发送，验证不丢失）
 *   场景4: 持久化验证（检查本地文件是否正确写入）
 *   场景5: 模拟崩溃恢复（发送后断开，检查文件中有未完成任务）
 */

const { io } = require("socket.io-client");
const fs = require("fs");
const path = require("path");
const os = require("os");

const SERVER_URL = "http://127.0.0.1:17521";

// 持久化文件路径（与 store.js 一致）
const STORE_DIR = path.join(
  os.platform() === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "hiprint")
    : os.platform() === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "hiprint")
    : path.join(os.homedir(), ".config", "hiprint"),
  "print-queue"
);
const STORE_FILE = path.join(STORE_DIR, "pending-tasks.json");

// 测试结果
const testResults = {
  passed: 0,
  failed: 0,
  details: [],
};

let totalExpected = 0;
let receivedCount = 0;
const results = {};

// ========== 工具函数 ==========

function assert(condition, testName, detail) {
  if (condition) {
    testResults.passed++;
    testResults.details.push({ name: testName, status: "PASS", detail: detail || "" });
    console.log(`  [PASS] ${testName}`);
  } else {
    testResults.failed++;
    testResults.details.push({ name: testName, status: "FAIL", detail: detail || "" });
    console.log(`  [FAIL] ${testName} — ${detail || "断言失败"}`);
  }
}

function readStoreFile() {
  try {
    if (!fs.existsSync(STORE_FILE)) {
      return [];
    }
    const content = fs.readFileSync(STORE_FILE, "utf-8");
    if (!content || content.trim() === "") {
      return [];
    }
    return JSON.parse(content);
  } catch (err) {
    return [];
  }
}

function clearStoreFile() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      fs.writeFileSync(STORE_FILE, "[]", "utf-8");
    }
  } catch (err) {
    // 忽略
  }
}

function createValidTemplate(taskIndex) {
  return {
    panels: [
      {
        index: 0,
        height: 40,
        width: 60,
        paperNumberDisabled: true,
        printElements: [
          {
            tid: "test.text",
            options: {
              left: 10,
              top: 5,
              height: 30,
              width: 50,
              title: "标题",
              field: "title",
              testData: `测试任务 #${taskIndex + 1}`,
              fontSize: 16.9,
              fontWeight: "bold",
              textAlign: "center",
            },
            printElementType: { title: "文本", type: "text" },
          },
        ],
      },
    ],
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ========== 场景1: 正常 news-server 任务 ==========

async function testNormalNewsServer(socket, printerName) {
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  场景1: 正常 news-server 任务");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  return new Promise((resolve) => {
    const key = "normal-1";
    const taskData = {
      template: createValidTemplate(0),
      data: { title: "正常任务测试" },
      printer: printerName,
      templateId: key,
      title: "正常任务",
    };

    results[key] = { sendTime: Date.now(), callbackTime: null, status: null, msg: null };
    totalExpected = 1;

    const timeout = setTimeout(() => {
      assert(false, "正常任务回调", "15秒内未收到回调");
      resolve();
    }, 15000);

    socket.once("success", (data) => {
      clearTimeout(timeout);
      if (data.templateId === key) {
        results[key].callbackTime = Date.now();
        results[key].status = "success";
        assert(true, "正常任务收到 success 回调", `耗时 ${results[key].callbackTime - results[key].sendTime}ms`);
        resolve();
      }
    });

    socket.once("error", (data) => {
      clearTimeout(timeout);
      if (data.templateId === key) {
        results[key].callbackTime = Date.now();
        results[key].status = "error";
        assert(false, "正常任务收到 error 回调", `原因: ${data.msg}`);
        resolve();
      }
    });

    console.log(`  [发送] ${key} -> ${printerName}`);
    socket.emit("news-server", JSON.stringify(taskData));
  });
}

// ========== 场景2: 无效模板 ==========

async function testInvalidTemplate(socket, printerName) {
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  场景2: 无效模板（渲染异常）");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  return new Promise((resolve) => {
    const key = "invalid-1";
    const taskData = {
      template: { invalid: "not a valid template" }, // 故意传无效模板
      data: {},
      printer: printerName,
      templateId: key,
      title: "无效模板测试",
    };

    const timeout = setTimeout(() => {
      assert(false, "无效模板回调", "15秒内未收到 error 回调");
      resolve();
    }, 15000);

    socket.once("error", (data) => {
      clearTimeout(timeout);
      if (data.templateId === key) {
        assert(true, "无效模板收到 error 回调", `原因: ${data.msg}`);
        resolve();
      }
    });

    socket.once("success", (data) => {
      clearTimeout(timeout);
      if (data.templateId === key) {
        assert(false, "无效模板收到 success 回调", "无效模板不应该成功");
        resolve();
      }
    });

    console.log(`  [发送] ${key} -> ${printerName} (无效模板)`);
    socket.emit("news-server", JSON.stringify(taskData));
  });
}

// ========== 场景3: 并发 news-server 任务 ==========

async function testConcurrentNewsServer(socket, printerName) {
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  场景3: 并发 news-server 任务 (5个)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  return new Promise((resolve) => {
    const TASK_COUNT = 5;
    totalExpected = TASK_COUNT;
    receivedCount = 0;
    const concurrentResults = {};

    const sendTime = Date.now();

    for (let i = 0; i < TASK_COUNT; i++) {
      const key = `concurrent-${i + 1}`;
      const taskData = {
        template: createValidTemplate(i),
        data: { title: `并发任务 #${i + 1}` },
        printer: printerName,
        templateId: key,
        title: `并发测试 #${i + 1}`,
      };

      concurrentResults[key] = {
        index: i,
        sendTime: sendTime,
        callbackTime: null,
        status: null,
      };

      console.log(`  [发送] ${key} -> ${printerName}`);
      socket.emit("news-server", JSON.stringify(taskData));
    }

    const timeout = setTimeout(() => {
      const received = Object.values(concurrentResults).filter((r) => r.status).length;
      assert(false, "并发任务全部回调", `超时，只收到 ${received}/${TASK_COUNT}`);
      resolve();
    }, 60000);

    const checkComplete = () => {
      const received = Object.values(concurrentResults).filter((r) => r.status).length;
      if (received === TASK_COUNT) {
        clearTimeout(timeout);

        const successCount = Object.values(concurrentResults).filter((r) => r.status === "success").length;
        const errorCount = Object.values(concurrentResults).filter((r) => r.status === "error").length;
        const lostCount = Object.values(concurrentResults).filter((r) => !r.status).length;

        assert(lostCount === 0, "并发任务无丢失", `成功: ${successCount}, 失败: ${errorCount}, 丢失: ${lostCount}`);

        // 检查串行顺序
        const sorted = Object.values(concurrentResults)
          .filter((r) => r.callbackTime)
          .sort((a, b) => a.callbackTime - b.callbackTime);
        const callbackOrder = sorted.map((r) => r.index);
        const isSequential = callbackOrder.every((val, i) => val === i);
        assert(isSequential, "并发任务串行执行", `回调顺序: ${callbackOrder.map((i) => `#${i + 1}`).join(" -> ")}`);

        resolve();
      }
    };

    socket.on("success", (data) => {
      const key = data.templateId;
      if (concurrentResults[key]) {
        concurrentResults[key].callbackTime = Date.now();
        concurrentResults[key].status = "success";
        console.log(`  [成功] ${key} | 耗时 ${concurrentResults[key].callbackTime - concurrentResults[key].sendTime}ms`);
      }
      checkComplete();
    });

    socket.on("error", (data) => {
      const key = data.templateId;
      if (concurrentResults[key]) {
        concurrentResults[key].callbackTime = Date.now();
        concurrentResults[key].status = "error";
        console.log(`  [失败] ${key} | 原因: ${data.msg}`);
      }
      checkComplete();
    });
  });
}

// ========== 场景4: 持久化验证 ==========

async function testPersistence(socket, printerName) {
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  场景4: 持久化文件验证");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // 4.1 发送前清空文件，检查文件为空
  clearStoreFile();
  await sleep(500);
  const beforeTasks = readStoreFile();
  assert(beforeTasks.length === 0, "发送前持久化文件为空", `任务数: ${beforeTasks.length}`);

  // 4.2 发送一个 news-server 任务，立即检查文件
  const key = "persistence-1";
  const taskData = {
    template: createValidTemplate(0),
    data: { title: "持久化测试" },
    printer: printerName,
    templateId: key,
    title: "持久化测试",
  };

  socket.emit("news-server", JSON.stringify(taskData));

  // 等待一小段时间让主进程处理
  await sleep(1000);

  const afterSendTasks = readStoreFile();
  assert(afterSendTasks.length > 0, "发送后持久化文件非空", `任务数: ${afterSendTasks.length}`);

  // 检查文件中是否包含 template 字段（news-server 任务在渲染前就持久化）
  const hasTemplate = afterSendTasks.some((t) => t.templateId === key);
  assert(hasTemplate, "持久化文件包含发送的任务", `templateId: ${key}`);

  // 检查任务状态
  const task = afterSendTasks.find((t) => t.templateId === key);
  if (task) {
    assert(task.status === "rendering" || task.status === "pending" || task.status === "printing",
      "任务状态为 rendering/pending/printing", `实际状态: ${task.status}`);
  }

  // 4.3 等待任务完成后检查文件
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      // 即使超时也检查文件
      const afterCompleteTasks = readStoreFile();
      const stillExists = afterCompleteTasks.some((t) => t.templateId === key);
      assert(!stillExists, "任务完成后从文件中移除", stillExists ? "任务仍在文件中" : "已移除");
      resolve();
    }, 30000);

    socket.once("success", (data) => {
      if (data.templateId === key) {
        clearTimeout(timeout);
        // 等一小段时间让 store.removeTask 执行
        setTimeout(() => {
          const afterCompleteTasks = readStoreFile();
          const stillExists = afterCompleteTasks.some((t) => t.templateId === key);
          assert(!stillExists, "任务完成后从文件中移除", stillExists ? "任务仍在文件中" : "已移除");
          resolve();
        }, 1000);
      }
    });

    socket.once("error", (data) => {
      if (data.templateId === key) {
        clearTimeout(timeout);
        setTimeout(() => {
          const afterCompleteTasks = readStoreFile();
          const stillExists = afterCompleteTasks.some((t) => t.templateId === key);
          assert(!stillExists, "任务失败后从文件中移除", stillExists ? "任务仍在文件中" : "已移除");
          resolve();
        }, 1000);
      }
    });
  });
}

// ========== 场景5: 模拟崩溃恢复 ==========

async function testCrashRecovery(printerName) {
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  场景5: 模拟崩溃恢复");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  (发送任务后立即断开连接，模拟应用崩溃)");

  // 清空文件
  clearStoreFile();
  await sleep(300);

  // 创建一个临时连接，发送任务后立即断开
  const tempSocket = io(SERVER_URL, {
    transports: ["websocket"],
    reconnection: false,
  });

  return new Promise((resolve) => {
    tempSocket.on("connect", () => {
      console.log(`  [临时连接] socketId=${tempSocket.id}`);

      // 发送3个任务
      for (let i = 0; i < 3; i++) {
        const key = `crash-${i + 1}`;
        const taskData = {
          template: createValidTemplate(i),
          data: { title: `崩溃恢复测试 #${i + 1}` },
          printer: printerName,
          templateId: key,
          title: `崩溃测试 #${i + 1}`,
        };

        console.log(`  [发送] ${key} -> ${printerName}`);
        tempSocket.emit("news-server", JSON.stringify(taskData));
      }

      // 等一小段时间让主进程接收并持久化
      setTimeout(() => {
        // 立即断开连接，模拟崩溃
        tempSocket.disconnect();
        console.log("  [断开] 模拟崩溃，连接已断开");

        // 检查持久化文件
        setTimeout(() => {
          const tasks = readStoreFile();
          console.log(`  [检查] 持久化文件中有 ${tasks.length} 个任务`);

          assert(tasks.length > 0, "崩溃后持久化文件非空", `任务数: ${tasks.length}`);

          // 检查是否有 crash 开头的任务
          const crashTasks = tasks.filter((t) => t.templateId && t.templateId.startsWith("crash-"));
          assert(crashTasks.length > 0, "崩溃后文件中包含未完成任务", `crash任务数: ${crashTasks.length}`);

          // 检查任务是否包含 template 字段（可恢复）
          const hasTemplate = crashTasks.some((t) => t.template);
          assert(hasTemplate, "未完成任务包含 template 字段（可恢复渲染）", hasTemplate ? "包含template" : "缺少template");

          // 检查任务是否有 printer 字段
          const hasPrinter = crashTasks.some((t) => t.printer || t._resolvedPrinter);
          assert(hasPrinter, "未完成任务包含 printer 字段", hasPrinter ? "包含printer" : "缺少printer");

          console.log("");
          console.log("  [说明] 这些任务将在下次启动应用时通过 restorePendingTasks() 恢复");
          console.log("  [说明] 有 html 的直接入打印队列，只有 template 的会重新渲染");

          resolve();
        }, 2000);
      }, 1500);
    });

    tempSocket.on("connect_error", (err) => {
      assert(false, "临时连接", `连接失败: ${err.message}`);
      resolve();
    });
  });
}

// ========== 场景6: news 和 news-server 混合并发 ==========

async function testMixedConcurrent(socket, printerName) {
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  场景6: news + news-server 混合并发");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  return new Promise((resolve) => {
    const mixedResults = {};
    const TASKS_PER_TYPE = 2;
    const TOTAL = TASKS_PER_TYPE * 2;
    let received = 0;

    // 发送 news 类型任务（直接带 html）
    for (let i = 0; i < TASKS_PER_TYPE; i++) {
      const key = `news-mixed-${i + 1}`;
      const taskData = {
        html: `<div style="padding:20px;font-size:20px;">news直接打印 #${i + 1}</div>`,
        printer: printerName,
        templateId: key,
        title: `news混合测试 #${i + 1}`,
      };
      mixedResults[key] = { sendTime: Date.now(), callbackTime: null, status: null, type: "news" };
      console.log(`  [发送-news] ${key} -> ${printerName}`);
      socket.emit("news", taskData);
    }

    // 发送 news-server 类型任务（带模板）
    for (let i = 0; i < TASKS_PER_TYPE; i++) {
      const key = `server-mixed-${i + 1}`;
      const taskData = {
        template: createValidTemplate(i),
        data: { title: `server混合 #${i + 1}` },
        printer: printerName,
        templateId: key,
        title: `server混合测试 #${i + 1}`,
      };
      mixedResults[key] = { sendTime: Date.now(), callbackTime: null, status: null, type: "news-server" };
      console.log(`  [发送-server] ${key} -> ${printerName}`);
      socket.emit("news-server", JSON.stringify(taskData));
    }

    const timeout = setTimeout(() => {
      const receivedCount = Object.values(mixedResults).filter((r) => r.status).length;
      assert(false, "混合并发全部回调", `超时，只收到 ${receivedCount}/${TOTAL}`);
      resolve();
    }, 60000);

    const checkComplete = () => {
      received = Object.values(mixedResults).filter((r) => r.status).length;
      if (received === TOTAL) {
        clearTimeout(timeout);

        const lost = Object.values(mixedResults).filter((r) => !r.status).length;
        assert(lost === 0, "混合并发无丢失", `丢失: ${lost}`);

        // 检查两种类型都有回调
        const newsReceived = Object.values(mixedResults).filter((r) => r.type === "news" && r.status).length;
        const serverReceived = Object.values(mixedResults).filter((r) => r.type === "news-server" && r.status).length;
        assert(newsReceived === TASKS_PER_TYPE, "news 类型任务全部回调", `收到: ${newsReceived}/${TASKS_PER_TYPE}`);
        assert(serverReceived === TASKS_PER_TYPE, "news-server 类型任务全部回调", `收到: ${serverReceived}/${TASKS_PER_TYPE}`);

        resolve();
      }
    };

    socket.on("success", (data) => {
      const key = data.templateId;
      if (mixedResults[key]) {
        mixedResults[key].callbackTime = Date.now();
        mixedResults[key].status = "success";
        console.log(`  [成功] ${key} (${mixedResults[key].type})`);
      }
      checkComplete();
    });

    socket.on("error", (data) => {
      const key = data.templateId;
      if (mixedResults[key]) {
        mixedResults[key].callbackTime = Date.now();
        mixedResults[key].status = "error";
        console.log(`  [失败] ${key} (${mixedResults[key].type}) | ${data.msg}`);
      }
      checkComplete();
    });
  });
}

// ========== 主流程 ==========

async function runAllTests() {
  console.log("╔════════════════════════════════════════════════╗");
  console.log("║  news-server 完整场景测试                      ║");
  console.log("╚════════════════════════════════════════════════╝");
  console.log(`连接目标: ${SERVER_URL}`);
  console.log(`持久化文件: ${STORE_FILE}`);
  console.log("");

  // 检查参数
  const onlyPersistence = process.argv.includes("--persistence");
  const onlyCrash = process.argv.includes("--crash");

  if (onlyPersistence) {
    console.log("[模式] 仅持久化验证");
    const tasks = readStoreFile();
    console.log(`持久化文件中有 ${tasks.length} 个任务:`);
    tasks.forEach((t) => {
      console.log(`  - taskId: ${t.taskId}, templateId: ${t.templateId}, status: ${t.status}, hasHtml: ${!!t.html}, hasTemplate: ${!!t.template}`);
    });
    return;
  }

  if (onlyCrash) {
    console.log("[模式] 仅崩溃恢复测试");
    const socket = io(SERVER_URL, { transports: ["websocket"], reconnection: false });
    socket.on("connect", async () => {
      socket.on("printerList", async (printers) => {
        const defaultPrinter = printers.find((p) => p.isDefault);
        const printerName = defaultPrinter ? defaultPrinter.name : printers[0]?.name;
        await testCrashRecovery(printerName);
        socket.disconnect();
        printFinalReport();
      });
    });
    socket.on("connect_error", (err) => {
      console.error(`连接失败: ${err.message}`);
      process.exit(1);
    });
    return;
  }

  // 完整测试流程
  const socket = io(SERVER_URL, {
    transports: ["websocket"],
    reconnection: false,
  });

  socket.on("connect_error", (err) => {
    console.error(`[连接失败] ${err.message}`);
    console.error("请确认 electron-hiprint 应用已启动 (npm start)");
    process.exit(1);
  });

  socket.on("connect", () => {
    console.log(`[连接成功] socketId=${socket.id}`);
    console.log("");

    socket.on("printerList", async (printers) => {
      console.log(`[打印机列表] 共 ${printers.length} 台:`);
      printers.forEach((p) => {
        console.log(`  - ${p.name} (默认: ${p.isDefault ? "是" : "否"})`);
      });

      const defaultPrinter = printers.find((p) => p.isDefault);
      const printerName = defaultPrinter ? defaultPrinter.name : printers[0]?.name;

      if (!printerName) {
        console.error("[错误] 未找到可用打印机");
        socket.disconnect();
        process.exit(1);
      }

      console.log(`[使用打印机] ${printerName}`);

      // 依次执行各场景
      try {
        // 场景1: 正常任务
        await testNormalNewsServer(socket, printerName);
        await sleep(1000);

        // 场景2: 无效模板
        await testInvalidTemplate(socket, printerName);
        await sleep(1000);

        // 场景3: 并发任务
        await testConcurrentNewsServer(socket, printerName);
        await sleep(1000);

        // 场景4: 持久化验证
        await testPersistence(socket, printerName);
        await sleep(1000);

        // 场景5: 模拟崩溃恢复
        await testCrashRecovery(printerName);
        await sleep(1000);

        // 场景6: 混合并发
        await testMixedConcurrent(socket, printerName);
      } catch (err) {
        console.error("测试异常:", err);
      }

      socket.disconnect();
      printFinalReport();
    });
  });
}

function printFinalReport() {
  console.log("");
  console.log("╔════════════════════════════════════════════════╗");
  console.log("║  测试报告                                      ║");
  console.log("╚════════════════════════════════════════════════╝");
  console.log("");
  console.log(`通过: ${testResults.passed}  失败: ${testResults.failed}  总计: ${testResults.passed + testResults.failed}`);
  console.log("");

  if (testResults.failed > 0) {
    console.log("失败项:");
    testResults.details
      .filter((d) => d.status === "FAIL")
      .forEach((d) => {
        console.log(`  [FAIL] ${d.name} — ${d.detail}`);
      });
    console.log("");
  }

  console.log("详细结果:");
  testResults.details.forEach((d) => {
    console.log(`  [${d.status}] ${d.name}${d.detail ? " — " + d.detail : ""}`);
  });

  console.log("");
  if (testResults.failed === 0) {
    console.log(">>> 全部测试通过");
  } else {
    console.log(`>>> ${testResults.failed} 项测试失败`);
  }
  console.log("");

  process.exit(testResults.failed > 0 ? 1 : 0);
}

runAllTests();
