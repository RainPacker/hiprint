/**
 * news-server 接口测试脚本
 *
 * 使用方法：
 *   1. 先启动 electron-hiprint 应用（npm start）
 *   2. 再运行本脚本：node test-news-server.js
 *
 * news-server 流程：
 *   客户端 emit("news-server", data)
 *     → 主进程转发到 MAIN_WINDOW 的 getHtml 事件
 *     → 渲染进程用 hiprint.PrintTemplate 生成 HTML
 *     → 渲染进程 ipc.send("htmlPrint", data) 回主进程
 *     → 主进程 enqueuePrintTask 加入打印队列
 *
 * 与 news 接口的区别：
 *   news: 客户端直接传 html 字符串
 *   news-server: 客户端传 template + data，由服务端渲染生成 html
 */

const { io } = require("socket.io-client");

const SERVER_URL = "http://127.0.0.1:17521";
const TASK_COUNT = 5;

// 记录每个任务的发送时间和回调时间
const results = {};
let receivedCount = 0;

/**
 * 生成一个简单的 hiprint 模板
 * 包含一个文本元素，显示传入的 title 字段
 */
function createTemplate(taskIndex) {
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
              title: "测试标题",
              field: "title",
              testData: `news-server 测试任务 #${taskIndex + 1}`,
              fontSize: 16.9,
              fontWeight: "bold",
              textAlign: "center",
            },
            printElementType: { title: "文本", type: "text" },
          },
          {
            tid: "test.text2",
            options: {
              left: 10,
              top: 20,
              height: 15,
              width: 50,
              title: "时间",
              field: "time",
              testData: new Date().toLocaleString(),
              fontSize: 12,
              textAlign: "center",
            },
            printElementType: { title: "文本", type: "text" },
          },
        ],
        paperNumberLeft: 0,
        paperNumberTop: 0,
      },
    ],
  };
}

function runTest() {
  console.log("========================================");
  console.log("  news-server 接口测试");
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

    socket.on("printerList", (printers) => {
      console.log(`[打印机列表] 共 ${printers.length} 台打印机:`);
      printers.forEach((p) => {
        console.log(`  - ${p.name} (默认: ${p.isDefault ? "是" : "否"})`);
      });
      console.log("");

      const defaultPrinter = printers.find((p) => p.isDefault);
      const printerName = defaultPrinter ? defaultPrinter.name : printers[0]?.name;

      if (!printerName) {
        console.error("[错误] 未找到可用打印机");
        socket.disconnect();
        return;
      }

      console.log(`[使用打印机] ${printerName}`);
      console.log("");
      console.log(`>>> 通过 news-server 接口发送 ${TASK_COUNT} 个打印任务...`);
      console.log("    (服务端渲染模板 → 生成HTML → 加入打印队列)");
      console.log("");

      const sendTime = Date.now();

      for (let i = 0; i < TASK_COUNT; i++) {
        const key = `server-task-${i + 1}`;
        const taskData = {
          template: createTemplate(i),
          data: {
            title: `news-server 测试 #${i + 1}`,
            time: new Date().toLocaleString(),
          },
          printer: printerName,
          templateId: key,
          title: `服务端渲染测试 #${i + 1}`,
        };

        results[key] = {
          index: i,
          printer: printerName,
          sendTime: sendTime,
          callbackTime: null,
          status: null,
          msg: null,
        };

        console.log(`[发送] ${key} -> ${printerName} (template含${taskData.template.panels[0].printElements.length}个元素)`);
        // news-server 发送的是 JSON 字符串或对象
        socket.emit("news-server", JSON.stringify(taskData));
      }

      console.log("");
      console.log("等待打印回调...");
      console.log("");
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
    console.log(`[成功] ${key} | 耗时 ${elapsed}ms | ${data.msg}`);
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
    console.log(`[失败] ${key} | 耗时 ${elapsed}ms | ${data.msg}`);
    checkComplete(socket);
  });

  socket.on("connect_error", (err) => {
    console.error(`[连接失败] ${err.message}`);
    console.error("请确认 electron-hiprint 应用已启动 (npm start)");
    process.exit(1);
  });

  // 全局超时
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
}

function checkComplete(socket) {
  if (receivedCount === TASK_COUNT) {
    console.log("");
    printReport();
    socket.disconnect();
    process.exit(0);
  }
}

function printReport() {
  console.log("========================================");
  console.log("  news-server 测试报告");
  console.log("========================================");

  const allResults = Object.values(results);
  const successCount = allResults.filter((r) => r.status === "success").length;
  const errorCount = allResults.filter((r) => r.status === "error").length;
  const lostCount = allResults.filter((r) => !r.status).length;

  console.log(`总任务数: ${TASK_COUNT}`);
  console.log(`成功: ${successCount}  失败: ${errorCount}  丢失: ${lostCount}`);
  console.log("");

  console.log("任务执行详情:");
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
  console.log(`任务丢失: ${lostCount === 0 ? "无" : `有 (${lostCount}个)`}`);
  console.log("");

  if (lostCount === 0 && isSequential) {
    console.log(">>> 测试通过: news-server 接口串行执行，无任务丢失");
  } else if (lostCount === 0) {
    console.log(">>> 测试部分通过: 无任务丢失，但执行顺序非严格串行");
  } else {
    console.log(">>> 测试失败: 存在任务丢失");
  }
  console.log("========================================");
}

runTest();
