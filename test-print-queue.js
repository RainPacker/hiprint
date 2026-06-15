/**
 * 并发打印队列测试脚本
 *
 * 使用方法：
 *   1. 先启动 electron-hiprint 应用（npm start）
 *   2. 再运行本脚本：node test-print-queue.js
 *
 * 脚本会同时发送5个打印任务，验证：
 *   - 5个任务是否全部收到回调（无丢失）
 *   - 回调顺序是否与发送顺序一致（串行执行）
 *   - 各任务之间是否有合理的时间间隔（非同时提交到打印机）
 */

const { io } = require("socket.io-client");

const SERVER_URL = "http://127.0.0.1:17521";
const TASK_COUNT = 5;

// 记录每个任务的发送时间和回调时间
const results = {};
let receivedCount = 0;

function generateHtml(taskIndex) {
  return `
    <div style="padding: 20px; font-size: 24px; font-family: sans-serif;">
      <h1>打印队列测试 - 任务 #${taskIndex + 1}</h1>
      <p>发送时间: ${new Date().toISOString()}</p>
      <p>这是第 ${taskIndex + 1} 个并发测试任务</p>
    </div>
  `;
}

function runTest() {
  console.log("========================================");
  console.log("  并发打印队列测试");
  console.log("========================================");
  console.log(`连接目标: ${SERVER_URL}`);
  console.log(`并发任务数: ${TASK_COUNT}`);
  console.log("");

  const socket = io(SERVER_URL, {
    transports: ["websocket"],
    reconnection: false,
  });

  socket.on("connect", () => {
    console.log(`[连接成功] socketId=${socket.id}`);
    console.log("");

    // 等待打印机列表返回，确认连接正常
    socket.on("printerList", (printers) => {
      console.log(`[打印机列表] 共 ${printers.length} 台打印机:`);
      printers.forEach((p) => {
        console.log(`  - ${p.name} (默认: ${p.isDefault ? "是" : "否"})`);
      });
      console.log("");

      // 获取默认打印机名称
      const defaultPrinter = printers.find((p) => p.isDefault);
      const printerName = defaultPrinter ? defaultPrinter.name : printers[0]?.name;

      if (!printerName) {
        console.error("[错误] 未找到可用打印机，请确认系统已安装打印机");
        socket.disconnect();
        return;
      }

      console.log(`[使用打印机] ${printerName}`);
      console.log("");
      console.log(`>>> 同时发送 ${TASK_COUNT} 个打印任务...`);
      console.log("");

      const sendTime = Date.now();

      // 同时发送5个打印任务
      for (let i = 0; i < TASK_COUNT; i++) {
        const taskData = {
          html: generateHtml(i),
          printer: printerName,
          templateId: `test-task-${i + 1}`,
          title: `队列测试 #${i + 1}`,
        };

        results[i] = {
          index: i,
          sendTime: sendTime,
          callbackTime: null,
          status: null,
          msg: null,
        };

        console.log(`[发送] 任务 #${i + 1} (templateId: ${taskData.templateId})`);
        socket.emit("news", taskData);
      }

      console.log("");
      console.log("等待打印回调...");
      console.log("");
    });
  });

  // 监听成功回调
  socket.on("success", (data) => {
    receivedCount++;
    const idx = parseInt(data.templateId.replace("test-task-", "")) - 1;
    if (results[idx]) {
      results[idx].callbackTime = Date.now();
      results[idx].status = "success";
      results[idx].msg = data.msg;
    }
    const elapsed = results[idx].callbackTime - results[idx].sendTime;
    console.log(`[成功] 任务 #${idx + 1} | 耗时 ${elapsed}ms | ${data.msg}`);
    checkComplete();
  });

  // 监听失败回调
  socket.on("error", (data) => {
    receivedCount++;
    const idx = parseInt(data.templateId.replace("test-task-", "")) - 1;
    if (results[idx]) {
      results[idx].callbackTime = Date.now();
      results[idx].status = "error";
      results[idx].msg = data.msg;
    }
    const elapsed = results[idx].callbackTime - results[idx].sendTime;
    console.log(`[失败] 任务 #${idx + 1} | 耗时 ${elapsed}ms | ${data.msg}`);
    checkComplete();
  });

  socket.on("connect_error", (err) => {
    console.error(`[连接失败] ${err.message}`);
    console.error("请确认 electron-hiprint 应用已启动 (npm start)");
    process.exit(1);
  });

  // 超时保护：60秒内未完成则强制退出
  setTimeout(() => {
    if (receivedCount < TASK_COUNT) {
      console.log("");
      console.log("========================================");
      console.log("  超时！60秒内未收到全部回调");
      console.log(`  已收到: ${receivedCount}/${TASK_COUNT}`);
      console.log("========================================");
      printReport();
      process.exit(1);
    }
  }, 60000);

  function checkComplete() {
    if (receivedCount === TASK_COUNT) {
      console.log("");
      printReport();
      socket.disconnect();
      process.exit(0);
    }
  }

  function printReport() {
    console.log("========================================");
    console.log("  测试报告");
    console.log("========================================");

    const successCount = Object.values(results).filter((r) => r.status === "success").length;
    const errorCount = Object.values(results).filter((r) => r.status === "error").length;
    const lostCount = Object.values(results).filter((r) => !r.status).length;

    console.log(`总任务数: ${TASK_COUNT}`);
    console.log(`成功: ${successCount}  失败: ${errorCount}  丢失: ${lostCount}`);
    console.log("");

    // 检查顺序性
    console.log("任务执行详情:");
    console.log("序号 | 状态   | 耗时(ms) | 回调时间差(ms)*");
    console.log("-----|--------|----------|----------------");

    let prevCallbackTime = null;
    let isOrdered = true;

    Object.values(results)
      .sort((a, b) => (a.callbackTime || Infinity) - (b.callbackTime || Infinity))
      .forEach((r) => {
        const gap = prevCallbackTime ? r.callbackTime - prevCallbackTime : 0;
        if (r.index !== Object.values(results).sort((a, b) => (a.callbackTime || Infinity) - (b.callbackTime || Infinity)).indexOf(r)) {
          // 检查是否按发送顺序回调
        }
        const status = r.status || "丢失";
        const elapsed = r.callbackTime ? r.callbackTime - r.sendTime : "-";
        console.log(
          ` #${r.index + 1}  | ${status.padEnd(6)} | ${String(elapsed).padEnd(8)} | ${gap}`
        );
        prevCallbackTime = r.callbackTime;
      });

    console.log("");
    console.log("* 回调时间差: 当前任务回调时间与上一个任务回调时间的差值");
    console.log("  如果都 > 0，说明任务是严格串行执行的");
    console.log("");

    // 检查是否按发送顺序完成
    const callbackOrder = Object.values(results)
      .filter((r) => r.callbackTime)
      .sort((a, b) => a.callbackTime - b.callbackTime)
      .map((r) => r.index);

    const isSequential = callbackOrder.every((val, i) => val === i);

    console.log(`回调顺序: ${callbackOrder.map((i) => `#${i + 1}`).join(" -> ")}`);
    console.log(`顺序执行: ${isSequential ? "是 (按发送顺序串行完成)" : "否 (存在乱序)"}`);
    console.log(`任务丢失: ${lostCount === 0 ? "无 (全部收到回调)" : `有 (${lostCount}个任务未收到回调)`}`);
    console.log("");

    if (lostCount === 0 && isSequential) {
      console.log(">>> 测试通过: 队列串行执行，无任务丢失");
    } else if (lostCount === 0 && !isSequential) {
      console.log(">>> 测试部分通过: 无任务丢失，但执行顺序非严格串行");
    } else {
      console.log(">>> 测试失败: 存在任务丢失");
    }
    console.log("========================================");
  }
}

runTest();
