const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const port = Number(process.env.PORT) || 4173;
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
http.createServer((req, res) => {
  const requestPath = new URL(req.url, 'http://localhost').pathname;
  let decoded;
  try { decoded = decodeURIComponent(requestPath); } catch { res.writeHead(400).end(); return; }
  const file = path.resolve(root, '.' + (decoded === '/' ? '/index.html' : decoded));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, content) => {
    if (error) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(content);
  });
}).listen(port, '127.0.0.1', () => process.stdout.write(`NERVA simulator: http://127.0.0.1:${port}\n`));
