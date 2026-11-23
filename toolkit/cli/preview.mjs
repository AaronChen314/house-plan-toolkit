// 本地预览：外链家具模型的模板/设计器必须走 http（file:// 读不到 assets/furniture/*.glb）。
// 用法：node scripts/preview.mjs [文件] [--port 8765] [--no-open]
//   node scripts/preview.mjs                                  → assets/template.html
//   node scripts/preview.mjs output/xxx/某户型-装修设计器.html      → 交付的设计器（同目录要有 assets/furniture/）
import fs from 'fs';
import {fileURLToPath} from 'node:url';
import http from 'http';
import path from 'path';
import { exec } from 'child_process';

const ROOT = process.cwd();
const DEFAULT_TEMPLATE = fileURLToPath(new URL('../legacy/assets/template.html', import.meta.url));
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const port = +flag('--port', 8765);
const noOpen = args.includes('--no-open') ? args.splice(args.indexOf('--no-open'), 1) && true : false;
const file = path.resolve(ROOT, args[0] || DEFAULT_TEMPLATE);
if (!fs.existsSync(file)) { console.error('File not found: ' + file + '. Check the path and retry.'); process.exit(1); }

// 站点根目录：让页面里的 `assets/furniture/…` 正好指向模型目录
const dir = path.dirname(file);
let root = dir, rel = path.basename(file);
if (!fs.existsSync(path.join(dir, 'assets', 'furniture')) && fs.existsSync(path.join(dir, 'furniture'))) {
  root = path.dirname(dir);
  rel = path.basename(dir) + '/' + path.basename(file);
}
const html = fs.readFileSync(file, 'utf8');
const external = /id="__furn3d"/.test(html) && /"b64":""/.test(html);
const embedded = /id="__furn3d"/.test(html) && !external;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp',
};
const server = http.createServer((req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || path.basename(file);
  if (p === 'favicon.ico') { res.writeHead(204); return res.end(); }
  const fp = path.resolve(root, p);
  if (fp !== path.resolve(root) && !fp.startsWith(path.resolve(root) + path.sep)) { res.writeHead(403); return res.end('403'); }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('404 ' + p); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`Port ${port} is in use. Retry with --port ${port + 1}.`); process.exit(1); }
  throw e;
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/${rel.split('/').map(encodeURIComponent).join('/')}`;
  console.log('预览地址：' + url);
  console.log('站点根目录：' + root);
  if (external) console.log('家具真模型：外链 assets/furniture/（必须走这个地址，双击 HTML 看不到模型）');
  else if (embedded) console.log('家具真模型：已内嵌 base64（这个 HTML 双击也能看）');
  else console.log('家具真模型：这份 HTML 没有装家具层');
  console.log('停止：Ctrl-C');
  if (!noOpen) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
    exec(`${cmd} "${url}"`);
  }
});
