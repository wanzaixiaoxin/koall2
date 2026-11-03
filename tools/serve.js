#!/usr/bin/env node
/** 零依赖静态服务器：npm run play 后浏览器打开提示的地址。 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = Number(process.argv[2] || process.env.PORT || 8000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const query = (req.url || '').includes('?') ? '?' + (req.url || '').split('?').slice(1).join('?') : '';

  // 根路径直接给主菜单（避免访问 :8000/ 看到 404 的困惑）
  if (urlPath === '/' || urlPath === '') {
    res.writeHead(302, { Location: '/web/' + query });
    return res.end();
  }

  let file = path.normalize(path.join(root, urlPath));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  // 目录：缺尾斜杠必须重定向到带斜杠的 URL——否则页面里的相对链接（./lab.html）
  // 会被浏览器解析到上一级（/lab.html → 404）。这是"主菜单能开、一点链接就进不去"的根因。
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    if (!urlPath.endsWith('/')) {
      res.writeHead(301, { Location: urlPath + '/' + query });
      return res.end();
    }
    file = path.join(file, 'index.html');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not Found: ' + urlPath);
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(port, () => {
  console.log(`\n  英雄守卫战 · Web 原型已启动:\n`);
  console.log(`    ➜  电脑浏览器:  http://localhost:${port}/web/`);
  console.log(`    ➜  手机(同局域网): http://<本机IP>:${port}/web/\n`);
  console.log('  Ctrl+C 停止\n');
});
