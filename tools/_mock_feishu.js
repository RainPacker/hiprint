// 临时：mock 飞书 webhook，验证 feishu.js 卡片 payload 结构
const http = require("http");
const fs = require("fs");
const marker = process.env.APPDATA + "\\electron-hiprint\\running.marker";

const server = http.createServer((req, res) => {
  let buf = "";
  req.on("data", (c) => (buf += c));
  req.on("end", () => {
    console.log("=== 收到 POST ===");
    try {
      const j = JSON.parse(buf);
      // 模拟飞书校验
      const errs = [];
      if (j.msg_type !== "interactive") errs.push("msg_type 非 interactive");
      const c = j.card || {};
      if (!c.header || !c.header.title || !c.header.title.content) errs.push("header.title 缺失");
      if (!["red", "blue", "green", "orange", "grey"].includes(c.header.template)) errs.push("header.template 非法: " + c.header.template);
      if (!Array.isArray(c.elements) || !c.elements.length) errs.push("elements 缺失");
      else {
        c.elements.forEach((e, i) => {
          if (e.tag === "div" && !e.text && !e.fields) errs.push(`elements[${i}] div 缺 text/fields`);
          if (e.tag === "note" && !Array.isArray(e.elements)) errs.push(`elements[${i}] note 缺 elements`);
        });
      }
      // detail 字段渲染检查
      const fields = (c.elements.find((e) => e.tag === "div" && e.fields) || {}).fields || [];
      console.log("卡片标题:", c.header.title.content, "| 模板色:", c.header.template);
      console.log("字段行数:", fields.length);
      fields.forEach((f) => console.log("  -", f.text.replace(/\*\*/g, "")));
      console.log(errs.length ? "校验失败: " + errs.join("; ") : "校验通过: 合法飞书卡片结构");
    } catch (e) {
      console.log("JSON 解析失败:", e.message);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"code":0,"msg":"success"}');
    // 只服务一次请求后退出（崩溃场景），测试场景手动停
    if (process.argv.includes("--once")) setTimeout(() => process.exit(0), 300);
  });
});
server.listen(17599, () => console.log("mock feishu webhook listening :17599"));
