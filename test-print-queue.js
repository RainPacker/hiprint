/**
 * 多打印机并发队列测试脚本
 *
 * 使用方法：
 *   1. 先启动 electron-hiprint 应用（npm start）
 *   2. 再运行本脚本：
 *      - 单打印机测试: node test-print-queue.js
 *      - 多打印机测试: node test-print-queue.js --multi
 *
 * 测试场景：
 *   默认模式: 向同一打印机发送5个并发任务，验证串行执行无丢失
 *   多打印机模式: 向不同打印机各发送任务，验证并行执行无丢失
 */

const { io } = require("socket.io-client");

const SERVER_URL = "http://127.0.0.1:17521";
const isMultiPrinterMode = process.argv.includes("--multi");

// 记录每个任务的发送时间和回调时间
const results = {};
let totalTaskCount = 0;
let receivedCount = 0;

function generateHtml(taskIndex, printerLabel) {
  return `
    <div style="padding: 20px; font-size: 24px; font-family: sans-serif;">
      <h1>打印队列测试 - 任务 #${taskIndex + 1}</h1>
      <p>打印机: ${printerLabel}</p>
      <p>发送时间: ${new Date().toISOString()}</p>
    </div>
  `;
}

function runTest() {
  console.log("========================================");
  console.log("  多打印机并发队列测试");
  console.log("========================================");
  console.log(`连接目标: ${SERVER_URL}`);
  console.log(`测试模式: ${isMultiPrinterMode ? "多打印机并行" : "单打印机串行"}`);
  console.log("");

  const socket = io(SERVER_URL, {
    transports: ["websocket"],
    reconnection: false,
  });

  socket.on("connect", () => {
    console.log(`[连接成功] socketId=${socket.id}`);
    console.log("");

    socket.on("printerList", (printers) => {
      console.log(`[打印机列表] 共 ${printers.length} 台打印机:`);
      printers.forEach((p) => {
        console.log(`  - ${p.name} (默认: ${p.isDefault ? "是" : "否"})`);
      });
      console.log("");

      if (printers.length === 0) {
        console.error("[错误] 未找到可用打印机，请确认系统已安装打印机");
        socket.disconnect();
        return;
      }

      if (isMultiPrinterMode) {
        runMultiPrinterTest(socket, printers);
      } else {
        runSinglePrinterTest(socket, printers);
      }
    });
  });

  // 监听成功回调
  socket.on("success", (data) => {
    receivedCount++;
    const key = data.templateId;
    if (results[key]) {
      results[key].callbackTime = Date.now();
      results[key].status = "success";
      results[key].msg = data.msg;
    }
    const elapsed = results[key].callbackTime - results[key].sendTime;
    console.log(`[成功] ${key} | 耗时 ${elapsed}ms | 打印机: ${results[key].printer}`);
    checkComplete(socket);
  });

  // 监听失败回调
  socket.on("error", (data) => {
    receivedCount++;
    const key = data.templateId;
    if (results[key]) {
      results[key].callbackTime = Date.now();
      results[key].status = "error";
      results[key].msg = data.msg;
    }
    const elapsed = results[key].callbackTime - results[key].sendTime;
    console.log(`[失败] ${key} | 耗时 ${elapsed}ms | 原因: ${data.msg}`);
    checkComplete(socket);
  });

  socket.on("connect_error", (err) => {
    console.error(`[连接失败] ${err.message}`);
    console.error("请确认 electron-hiprint 应用已启动 (npm start)");
    process.exit(1);
  });

  // 全局超时
  setTimeout(() => {
    if (receivedCount < totalTaskCount) {
      console.log("");
      console.log("========================================");
      console.log("  超时！60秒内未收到全部回调");
      console.log(`  已收到: ${receivedCount}/${totalTaskCount}`);
      console.log("========================================");
      printReport();
      process.exit(1);
    }
  }, 60000);
}

/**
 * 单打印机测试：向同一打印机发送5个并发任务
 * 预期：严格串行执行，按顺序完成
 */
function runSinglePrinterTest(socket, printers) {
  const defaultPrinter = printers.find((p) => p.isDefault);
  const printerName = defaultPrinter ? defaultPrinter.name : printers[0].name;
  const TASK_COUNT = 5;
  totalTaskCount = TASK_COUNT;

  console.log(`[测试] 向打印机 "${printerName}" 同时发送 ${TASK_COUNT} 个任务`);
  console.log("");

  const sendTime = Date.now();

  for (let i = 0; i < TASK_COUNT; i++) {
    const key = `task-${i + 1}`;
    const taskData = {
      html: generateHtml(i, printerName),
      printer: printerName,
      templateId: key,
      title: `串行测试 #${i + 1}`,
    };

    results[key] = {
      index: i,
      printer: printerName,
      sendTime: sendTime,
      callbackTime: null,
      status: null,
      msg: null,
    };

    console.log(`[发送] ${key} -> ${printerName}`);
    socket.emit("news", taskData);
  }

  console.log("");
  console.log("等待打印回调...");
  console.log("");
}

/**
 * 多打印机测试：向每台打印机各发送3个并发任务
 * 预期：不同打印机并行执行，同一打印机串行执行
 */
function runMultiPrinterTest(socket, printers) {
  // 最多使用3台打印机进行测试
  const testPrinters = printers.slice(0, 3);
  const TASKS_PER_PRINTER = 3;
  totalTaskCount = testPrinters.length * TASKS_PER_PRINTER;

  console.log(`[测试] 向 ${testPrinters.length} 台打印机各发送 ${TASKS_PER_PRINTER} 个任务`);
  console.log(`[预期] 不同打印机并行，同一打印机串行`);
  console.log("");

  const sendTime = Date.now();
  let taskIndex = 0;

  testPrinters.forEach((printer, pIdx) => {
    for (let i = 0; i < TASKS_PER_PRINTER; i++) {
      const key = `printer${pIdx + 1}-task${i + 1}`;
      const taskData = {
        html: generateHtml(taskIndex, printer.name),
        printer: printer.name,
        templateId: key,
        title: `并行测试 打印机${pIdx + 1}-任务${i + 1}`,
      };

      results[key] = {
        index: taskIndex,
        printer: printer.name,
        printerIndex: pIdx,
        taskInPrinter: i,
        sendTime: sendTime,
        callbackTime: null,
        status: null,
        msg: null,
      };

      console.log(`[发送] ${key} -> ${printer.name}`);
      socket.emit("news", taskData);
      taskIndex++;
    }
  });

  console.log("");
  console.log("等待打印回调...");
  console.log("");
}

function checkComplete(socket) {
  if (receivedCount === totalTaskCount) {
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

  const allResults = Object.values(results);
  const successCount = allResults.filter((r) => r.status === "success").length;
  const errorCount = allResults.filter((r) => r.status === "error").length;
  const lostCount = allResults.filter((r) => !r.status).length;

  console.log(`总任务数: ${totalTaskCount}`);
  console.log(`成功: ${successCount}  失败: ${errorCount}  丢失: ${lostCount}`);
  console.log("");

  if (isMultiPrinterMode) {
    printMultiPrinterReport(allResults);
  } else {
    printSinglePrinterReport(allResults);
  }
}

function printSinglePrinterReport(allResults) {
  console.log("任务执行详情 (同一打印机，应严格串行):");
  console.log("序号   | 状态   | 耗时(ms) | 回调间隔(ms)");
  console.log("-------|--------|----------|-------------");

  const sorted = [...allResults].sort((a, b) => (a.callbackTime || Infinity) - (b.callbackTime || Infinity));
  let prevTime = null;

  sorted.forEach((r) => {
    const gap = prevTime ? r.callbackTime - prevTime : 0;
    const status = r.status || "丢失";
    const elapsed = r.callbackTime ? r.callbackTime - r.sendTime : "-";
    console.log(` #${r.index + 1}    | ${status.padEnd(6)} | ${String(elapsed).padEnd(8)} | ${gap}`);
    prevTime = r.callbackTime;
  });

  console.log("");

  // 检查串行顺序
  const callbackOrder = sorted.filter((r) => r.callbackTime).map((r) => r.index);
  const isSequential = callbackOrder.every((val, i) => val === i);

  console.log(`回调顺序: ${callbackOrder.map((i) => `#${i + 1}`).join(" -> ")}`);
  console.log(`串行执行: ${isSequential ? "是" : "否"}`);
  console.log(`任务丢失: ${lostCount(allResults) === 0 ? "无" : `有`}`);
  console.log("");

  if (lostCount(allResults) === 0 && isSequential) {
    console.log(">>> 测试通过: 同一打印机串行执行，无任务丢失");
  } else if (lostCount(allResults) === 0) {
    console.log(">>> 测试部分通过: 无任务丢失，但执行顺序非严格串行");
  } else {
    console.log(">>> 测试失败: 存在任务丢失");
  }
  console.log("========================================");
}

function lostCount(allResults) {
  return allResults.filter((r) => !r.status).length;
}

function printMultiPrinterReport(allResults) {
  // 按打印机分组
  const printerGroups = {};
  allResults.forEach((r) => {
    const pName = r.printer;
    if (!printerGroups[pName]) {
      printerGroups[pName] = [];
    }
    printerGroups[pName].push(r);
  });

  console.log("按打印机分组详情:");
  console.log("");

  let allPrintersSequential = true;

  Object.entries(printerGroups).forEach(([pName, tasks]) => {
    console.log(`--- 打印机: ${pName} ---`);
    console.log("任务          | 状态   | 耗时(ms) | 回调间隔(ms)");
    console.log("--------------|--------|----------|-------------");

    const sorted = [...tasks].sort((a, b) => a.taskInPrinter - b.taskInPrinter);
    const sortedByTime = [...tasks].sort((a, b) => (a.callbackTime || Infinity) - (b.callbackTime || Infinity));
    let prevTime = null;

    sortedByTime.forEach((r) => {
      const gap = prevTime ? r.callbackTime - prevTime : 0;
      const status = r.status || "丢失";
      const elapsed = r.callbackTime ? r.callbackTime - r.sendTime : "-";
      const label = `P${r.printerIndex + 1}-T${r.taskInPrinter + 1}`;
      console.log(` ${label.padEnd(13)}| ${status.padEnd(6)} | ${String(elapsed).padEnd(8)} | ${gap}`);
      prevTime = r.callbackTime;
    });

    // 检查该打印机内的串行顺序
    const order = sortedByTime.filter((r) => r.callbackTime).map((r) => r.taskInPrinter);
    const isSeq = order.every((val, i) => val === i);
    console.log(`  串行顺序: ${isSeq ? "是" : "否"}`);
    if (!isSeq) allPrintersSequential = false;
    console.log("");
  });

  // 检查跨打印机并行性
  console.log("--- 跨打印机并行性分析 ---");
  const allCallbacks = allResults
    .filter((r) => r.callbackTime)
    .sort((a, b) => a.callbackTime - b.callbackTime);

  // 检查是否有不同打印机的任务时间重叠（并行执行）
  let hasOverlap = false;
  const printerTimeRanges = {};
  Object.entries(printerGroups).forEach(([pName, tasks]) => {
    const times = tasks.filter((t) => t.callbackTime).map((t) => t.callbackTime).sort();
    if (times.length > 0) {
      printerTimeRanges[pName] = { start: times[0], end: times[times.length - 1] };
    }
  });

  const rangeEntries = Object.entries(printerTimeRanges);
  for (let i = 0; i < rangeEntries.length; i++) {
    for (let j = i + 1; j < rangeEntries.length; j++) {
      const [, a] = rangeEntries[i];
      const [, b] = rangeEntries[j];
      // 检查时间范围是否重叠
      if (a.start < b.end && b.start < a.end) {
        hasOverlap = true;
      }
    }
  }

  console.log(`不同打印机并行执行: ${hasOverlap ? "是 (检测到时间重叠)" : "否 (可能只有一台打印机)"}`);
  console.log(`同一打印机串行执行: ${allPrintersSequential ? "是" : "否"}`);
  console.log(`任务丢失: ${lostCount(allResults) === 0 ? "无" : `有 (${lostCount(allResults)}个)`}`);
  console.log("");

  const lc = lostCount(allResults);
  if (lc === 0 && allPrintersSequential) {
    console.log(">>> 测试通过: 不同打印机并行，同一打印机串行，无任务丢失");
  } else if (lc === 0) {
    console.log(">>> 测试部分通过: 无任务丢失，但同一打印机内存在乱序");
  } else {
    console.log(">>> 测试失败: 存在任务丢失");
  }
  console.log("========================================");
}

runTest();
