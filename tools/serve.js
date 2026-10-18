#!/usr/bin/env node
/** 零依赖静态服务器：npm run play 后浏览器打开提示的地址。
 *  附带 POST /api/trace 录制端点：web 端人工走位轨迹追加到 traces/web-<日期>.jsonl。 */
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

const TRACE_DIR = path.join(root, 'traces');
const MAX_TRACE_BODY = 2 * 1024 * 1024; // 单次 ≤2MB（客户端每 1.5s 刷一次，正常远小于此）

/** 人工轨迹落盘：一行一条 JSON 记录，按天一个文件（traces/ 已 gitignore）。 */
function handleTracePost(req, res) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_TRACE_BODY) {
      res.writeHead(413);
      req.destroy();
      return res.end('Payload Too Large');
    }
    chunks.push(c);
  });
  req.on('end', () => {
    try {
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      fs.mkdirSync(TRACE_DIR, { recursive: true });
      fs.appendFileSync(path.join(TRACE_DIR, `web-${stamp}.jsonl`), Buffer.concat(chunks));
      res.writeHead(204);
      res.end();
    } catch (e) {
      res.writeHead(500);
      res.end(String(e && e.message));
    }
  });
}

http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (req.method === 'POST' && urlPath === '/api/trace') {
    return handleTracePost(req, res);
  }
  let file = path.normalize(path.join(root, urlPath));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
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
  console.log('  · 人工走位轨迹自动录制到 traces/web-<日期>.jsonl（gitignore）');
  console.log('  · 回放验证: npm run sim -- --replay traces/web-<日期>.jsonl\n');
  console.log('  Ctrl+C 停止\n');
});
