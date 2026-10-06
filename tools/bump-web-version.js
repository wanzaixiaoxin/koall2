#!/usr/bin/env node
/** 打包后自动递增 web 页面里的资源版本参数（?v=N → N+1），强制浏览器拉取新包。 */
const fs = require('fs');

for (const file of ['web/game.html', 'web/lab.html']) {
  let html = fs.readFileSync(file, 'utf8');
  html = html.replace(/(bundle\.js|lab\.js)\?v=(\d+)/g, (m, name, n) => `${name}?v=${Number(n) + 1}`);
  fs.writeFileSync(file, html);
  console.log(`[版本] ${file} 资源版本已递增`);
}
