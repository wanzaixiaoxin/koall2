#!/usr/bin/env node
/** 打包后冒烟检查：web bundle 必须包含关键符号（防"引用了但忘导入"的渲染期崩溃）。 */
const fs = require('fs');

const checks = [
  ['web/bundle.js', ['drawMonster', 'drawProjectile', 'drawHealPulse', 'drawTransfer', 'pushFloat']],
  ['web/lab.js', ['drawMonster', 'drawProjectile', 'drawHealPulse', 'drawTransfer', 'pushFloat']],
];

let failed = false;
for (const [file, symbols] of checks) {
  if (!fs.existsSync(file)) {
    console.error(`[冒烟] 缺少文件: ${file}`);
    failed = true;
    continue;
  }
  const content = fs.readFileSync(file, 'utf8');
  for (const sym of symbols) {
    if (!content.includes(sym)) {
      console.error(`[冒烟] ${file} 缺少符号: ${sym}`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log('[冒烟] web 包关键符号检查通过');
