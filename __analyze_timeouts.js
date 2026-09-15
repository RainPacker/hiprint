// 临时分析：检查是否存在同一 taskId 两次 onTaskDone（迟到的 print 回调 = 重复出纸风险）
const fs = require("fs");
const lines = fs.readFileSync("C:\\Users\\yangyang.zhang\\Desktop\\crash-2026-09-14.log", "utf-8").split("\n");
const counts = new Map();
for (const l of lines) {
  const m = l.match(/\[onTaskDone\] taskId=(\d+) printer="([^"]+)" success=(\S+)/);
  if (m) {
    const key = m[1];
    const e = counts.get(key) || { n: 0, printer: m[2], results: [] };
    e.n++;
    e.results.push(m[3]);
    counts.set(key, e);
  }
}
let dup = 0;
for (const [id, e] of counts) {
  if (e.n > 1) {
    dup++;
    console.log(`重复 onTaskDone: taskId=${id} printer="${e.printer}" 次数=${e.n} 结果=${e.results.join(",")}`);
  }
}
console.log(`onTaskDone 总记录唯一 taskId 数: ${counts.size}, 重复taskId数: ${dup}`);
