// 公共浏览器启动：所有 check / qa / dev 脚本都从这里启动无头 Chrome，Windows / macOS / Linux（含云端容器、root、无显卡）通用。
// 找浏览器的顺序：环境变量 CHROME_PATH / PUPPETEER_EXECUTABLE_PATH → 系统 Chrome / Edge / Chromium → Playwright / Puppeteer 自带浏览器缓存。
// 用法：
//   import { launch, gpuInfo, setDownloadDir } from './browser.mjs';
//   const b = await launch({ gpu: true, viewport: { width: 1600, height: 1000 } });   // gpu: true = 真显卡（找不到显卡时 Chrome 自己退回软件渲染）；false = 软件渲染（结果稳定，check 用）
//   const info = await gpuInfo(page);   // { renderer, software }：software = true 说明没有显卡（SwiftShader / llvmpipe），验收要进慢速模式
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOME = os.homedir();
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const PF = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], 'C:/Program Files', 'C:/Program Files (x86)'].filter(Boolean);

/** 在缓存目录里按通配找可执行文件（Playwright：ms-playwright/chromium-1234/chrome-linux/chrome；Puppeteer：puppeteer/chrome/linux-131.0/chrome-linux64/chrome） */
function cached(root, ...tail) {
  try {
    const out = [];
    for (const d of fs.readdirSync(root).sort().reverse()) for (const t of tail) out.push(path.join(root, d, t));
    return out;
  } catch { return []; }
}
function puppeteerCache(root) {
  const out = [];
  for (const sub of ['chrome', 'chromium', 'chrome-headless-shell']) for (const p of cached(path.join(root, sub),
    'chrome-linux64/chrome', 'chrome-win64/chrome.exe', 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-headless-shell-linux64/chrome-headless-shell')) out.push(p);
  return out;
}

export function chromeCandidates() {
  const pw = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(HOME, '.cache', 'ms-playwright'), path.join(LOCAL, 'ms-playwright'), path.join(HOME, 'Library', 'Caches', 'ms-playwright')].filter(Boolean);
  return [
    process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH,
    ...PF.flatMap(p => [`${p}/Google/Chrome/Application/chrome.exe`, `${p}/Microsoft/Edge/Application/msedge.exe`]),
    path.join(LOCAL, 'Google/Chrome/Application/chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge',
    ...pw.flatMap(r => cached(r, 'chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-win/chrome.exe', 'chrome-win64/chrome.exe', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
    ...puppeteerCache(process.env.PUPPETEER_CACHE_DIR || path.join(HOME, '.cache', 'puppeteer')),
  ].filter(Boolean);
}

export function findChrome() {
  const p = chromeCandidates().find(f => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  if (!p) {
    console.error('找不到 Chrome / Edge / Chromium。任选一种：\n  1. 设置环境变量 CHROME_PATH=浏览器可执行文件路径\n  2. Linux：apt install chromium（或 google-chrome-stable）\n  3. npx playwright install chromium（装到 ~/.cache/ms-playwright，本脚本会自动找到）');
    process.exit(1);
  }
  return p;
}

/** root 运行 / 容器里 Chrome 的沙箱起不来，必须 --no-sandbox；/dev/shm 很小的容器加 --disable-dev-shm-usage */
export function needNoSandbox() {
  if (process.env.CHROME_NO_SANDBOX) return process.env.CHROME_NO_SANDBOX !== '0';
  if (process.platform !== 'linux') return false;
  if (process.getuid?.() === 0) return true;
  try { return fs.existsSync('/.dockerenv') || /docker|containerd|kubepods/.test(fs.readFileSync('/proc/1/cgroup', 'utf8')); } catch { return false; }
}

const GPU_ARGS = {
  win32: ['--use-angle=d3d11'],
  darwin: ['--use-angle=metal'],
  linux: ['--use-angle=gl'],
};
const SOFT_ARGS = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'];
const BG_ARGS = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];

/**
 * @param {object} o
 * @param {boolean} [o.gpu=false]  true：用真显卡（d3d11 / metal / gl）；false：软件渲染 SwiftShader（截图稳定，check / dumprooms 用）
 * @param {boolean|'new'} [o.headless='new']
 * @param {{width:number,height:number}} [o.viewport]
 * @param {string[]} [o.args]  额外参数
 */
export async function launch({ gpu = false, headless = 'new', viewport = { width: 1600, height: 1000 }, args = [], protocolTimeout = 900000, timeout = 120000 } = {}) {
  const executablePath = findChrome();
  const a = [...(gpu ? [...(GPU_ARGS[process.platform] || []), '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] : SOFT_ARGS), ...BG_ARGS, '--hide-scrollbars', ...args];
  if (needNoSandbox()) a.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage');
  if (process.env.CHROME_ARGS) a.push(...process.env.CHROME_ARGS.split(/\s+/).filter(Boolean));
  return puppeteer.launch({ executablePath, headless, protocolTimeout, timeout, defaultViewport: viewport, args: [...new Set(a)] });
}

/** 页面里 WebGL 实际用的渲染器；software = true 表示没有显卡（SwiftShader / llvmpipe / Microsoft Basic Render），3D 会慢 10 倍以上 */
export async function gpuInfo(page) {
  const renderer = await page.evaluate(() => {
    try {
      const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
      if (!gl) return 'none';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    } catch (e) { return 'error ' + e; }
  });
  return { renderer, software: /swiftshader|llvmpipe|softpipe|basic render|software|none|error/i.test(renderer) };
}

/** 下载目录：用浏览器级 CDP 会话设置（页面级的 Page.setDownloadBehavior 在新版 Chrome 里不生效，导出文件会落不下来） */
export async function setDownloadDir(browser, page, dir) {
  fs.mkdirSync(dir, { recursive: true });
  try {
    const s = await browser.target().createCDPSession();
    await s.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.resolve(dir), eventsEnabled: true });
    return s;
  } catch {
    const s = await page.createCDPSession();
    await s.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: path.resolve(dir) }).catch(() => { });
    return s;
  }
}

/* ---------- 打开 HTML：外链家具模型需要 http，file:// 读不到 ---------- */
import http from 'http';
import { pathToFileURL } from 'url';
const _servers = new Map();

/** 设计器用了外链家具模型（`patch --external`）时，file:// 拿不到 assets/furniture/*.glb：
 *  这里自动在这一层目录起一个只读静态服务，返回 http 地址；其余情况仍然走 file://。 */
export async function pageUrl(file, query = '') {
  const abs = path.resolve(file);
  let html = '';
  try { html = fs.readFileSync(abs, 'utf8').slice(0, 6_000_000); } catch { }
  const dir = path.dirname(abs);
  const external = /id="__furn3d"/.test(html) && /"b64":""/.test(html);
  // 站点根目录：让页面里的 `assets/furniture/…` 正好指向模型目录。
  // 交付目录 = 输出目录/xxx.html + 输出目录/assets/furniture；模板仓库 = assets/template.html + assets/furniture（根要退到上一层）。
  let root = null, rel = '';
  if (external && fs.existsSync(path.join(dir, 'assets', 'furniture'))) { root = dir; rel = path.basename(abs); }
  else if (external && fs.existsSync(path.join(dir, 'furniture'))) { root = path.dirname(dir); rel = path.basename(dir) + '/' + path.basename(abs); }
  if (!root) return pathToFileURL(abs).href + query;
  let origin = _servers.get(root);
  if (!origin) {
    const TYPES = { '.html': 'text/html; charset=utf-8', '.glb': 'model/gltf-binary', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.js': 'text/javascript', '.webp': 'image/webp' };
    const server = http.createServer((req, res) => {
      const p2 = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'index.html';
      if (p2 === 'favicon.ico') { res.writeHead(204); return res.end(); }
      const fp = path.resolve(root, p2);
      if (!fp.startsWith(path.resolve(root))) { res.writeHead(403); return res.end('403'); }
      fs.readFile(fp, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('404'); }
        res.writeHead(200, { 'content-type': TYPES[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(buf);
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    server.unref();
    origin = `http://127.0.0.1:${server.address().port}`;
    _servers.set(root, origin);
  }
  return `${origin}/${rel.split('/').map(encodeURIComponent).join('/')}${query}`;
}
