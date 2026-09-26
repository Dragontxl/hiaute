/**
 * 构建脚本：将 frontend/index.html 内嵌到 src/worker.ts 的 FRONTEND_HTML 常量。
 *
 * 用法：node scripts/build-frontend.cjs
 *
 * worker.ts 注释已声明此脚本；此脚本将 HTML 中的反引号和 ${ 转义后写入模板字符串。
 */
const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '..', 'frontend', 'index.html');
const workerPath = path.join(__dirname, '..', 'src', 'worker.ts');

const html = fs.readFileSync(htmlPath, 'utf-8');
// 先转义反斜杠，再转义反引号和 ${。
// 顺序很关键：若不先转义 `\`，HTML 内 JS 的 `\n`、正则 `\d` 等会被外层模板字符串
// 提前解释（`\n` 变成真实换行 → 浏览器里字符串字面量未闭合 → 整个脚本语法错误）。
const escaped = html
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${');
const replacement = 'const FRONTEND_HTML = `' + escaped + '`;';

const worker = fs.readFileSync(workerPath, 'utf-8');

// 找到 FRONTEND_HTML 常量的起始位置
const startMarker = 'const FRONTEND_HTML = `';
const startIdx = worker.indexOf(startMarker);
if (startIdx === -1) {
  console.warn('未找到 FRONTEND_HTML 常量声明，worker.ts 未修改');
  process.exit(1);
}

// 从起始位置开始，找到模板字符串的结束（注意：HTML 内容可能包含转义的反引号）
// 策略：从 startMarker 之后开始，找到第一个未转义的 `; 序列
let searchFrom = startIdx + startMarker.length;
let endIdx = -1;
let i = searchFrom;
while (i < worker.length) {
  if (worker[i] === '\\') {
    i += 2; // 跳过转义字符
    continue;
  }
  if (worker[i] === '`' && worker[i + 1] === ';') {
    endIdx = i + 2; // 包含 `;
    break;
  }
  i++;
}

if (endIdx === -1) {
  console.warn('未找到 FRONTEND_HTML 模板字符串的结束，worker.ts 未修改');
  process.exit(1);
}

// 替换
const updated = worker.slice(0, startIdx) + replacement + '\n' + worker.slice(endIdx);
fs.writeFileSync(workerPath, updated, 'utf-8');
console.log('已更新 src/worker.ts 的 FRONTEND_HTML（' + html.length + ' 字节 HTML）');
