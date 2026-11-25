// 家具 3D 模型包：构建期把 CC0 家具模型拉下来 → 归一（去量化/去重/修剪）→ 量真实尺寸 → 落到 assets/furniture/
// 再把清单嵌进 assets/template.html，让设计器里「可移动家具」用真模型显示（定制柜体不受影响）。
//
// 用法：
//   node scripts/furniture3d.mjs search "sofa" [--provider threedassets] [--limit 10]
//   node scripts/furniture3d.mjs add <assetId> --as sofa-main [--keys sofa,loveseat] [--tint fabricBlue,linen] [--rot 0|90|180|270] [--no-flip] [--long-x]
//   node scripts/furniture3d.mjs list
//   node scripts/furniture3d.mjs inspect <file.glb>
//   node scripts/furniture3d.mjs patch [--template assets/template.html] [--external]
//   node scripts/furniture3d.mjs check --template assets/template.html
//
// 资产源：https://3d.shep.bot（27 个站聚合，无 key；本脚本只用其中单文件 glb 的 CC0 资产）
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { NodeIO } from '@gltf-transform/core';
import { writeFileAtomic } from '../store/atomic.mjs';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, dequantize, textureCompress } from '@gltf-transform/functions';


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.resolve(process.env.SPACE_ASSET_DIR || path.join(ROOT, 'furniture', 'assets'));
const CATALOG = path.join(OUT_DIR, 'catalog.json');
const TEMPLATE = path.join(ROOT, 'legacy', 'assets', 'template.html');
const API = 'https://3d.shep.bot/v1';

const MARK_BEGIN = '//__FURN3D_BEGIN__';
const MARK_END = '//__FURN3D_END__';
const HOOK_ANCHOR = 'n.traverse(u=>u.userData.fid=t.id),n;switch(t.type){';
const HOOK_PATCHED = 'n.traverse(u=>u.userData.fid=t.id),n;if(g3dFurn(n,t))return n.traverse(u=>u.userData.fid=t.id),n;switch(t.type){';
const MANIFEST_RE = /<!--__FURN3D__--><script id="__furn3d" type="application\/json">[\s\S]*?<\/script>/;

// ---------- 小工具 ----------
const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const has = (k) => { const i = args.indexOf(k); if (i < 0) return false; args.splice(i, 1); return true; };
const log = (...a) => console.log(...a);

async function api(p) {
  const r = await fetch(API + p, { headers: { 'user-agent': 'house-plan-designer/furniture3d' } });
  if (!r.ok) throw new Error(`${API}${p} → HTTP ${r.status}`);
  return r.json();
}

function readCatalog() {
  if (!fs.existsSync(CATALOG)) return { version: 1, base: 'assets/furniture/', models: {} };
  return JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
}
function writeCatalog(c) {
  c.updated = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  writeFileAtomic(CATALOG, JSON.stringify(c, null, 2) + '\n');
}

function newIO() {
  return new NodeIO().registerExtensions(ALL_EXTENSIONS);
}

// 单位猜测：和设计器运行时 rM() 同一套规则（>100 当毫米、>12 当厘米、否则米）
function unitScale(maxDim) {
  return maxDim > 100 ? 0.001 : maxDim > 12 ? 0.01 : 1;
}

// 顶点采样：算“高的一面”（靠背 / 床头板）在 +Z 还是 -Z，以及长轴是不是 X
function analyze(doc) {
  const scene = doc.getRoot().listScenes()[0];
  const pts = [];
  scene.traverse((node) => {
    const mesh = node.getMesh && node.getMesh();
    if (!mesh) return;
    const world = node.getWorldMatrix ? node.getWorldMatrix() : null;
    for (const prim of mesh.listPrimitives()) {
      const acc = prim.getAttribute('POSITION');
      if (!acc) continue;
      const arr = acc.getArray();
      const n = acc.getCount();
      const stride = Math.max(1, Math.floor(n / 4000));
      for (let i = 0; i < n; i += stride) {
        const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        if (world) {
          const e = world;
          pts.push([
            e[0] * x + e[4] * y + e[8] * z + e[12],
            e[1] * x + e[5] * y + e[9] * z + e[13],
            e[2] * x + e[6] * y + e[10] * z + e[14],
          ]);
        } else pts.push([x, y, z]);
      }
    }
  });
  if (!pts.length) return null;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let k = 0; k < 3; k++) { if (p[k] < min[k]) min[k] = p[k]; if (p[k] > max[k]) max[k] = p[k]; }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
  const yTop = min[1] + size[1] * 0.82;
  let zsum = 0, cnt = 0;
  for (const p of pts) if (p[1] >= yTop) { zsum += p[2]; cnt++; }
  const tallZ = cnt ? (zsum / cnt - cz) / Math.max(size[2] / 2, 1e-6) : 0;
  return { min, max, size, tallZ, aspect: size[0] / Math.max(size[2], 1e-6) };
}

function rotateRoots(doc, deg) {
  const a = (deg * Math.PI) / 180;
  const q = [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
  for (const node of doc.getRoot().listNodes()) if (!node.getParentNode()) node.setRotation(q);
}

// ---------- 子命令 ----------
async function search() {
  const q = args[0];
  const limit = +(flag('--limit', 25)) || 25;
  const providers = flag('--provider', '');
  if (!q) throw new Error('用法：search "<关键词>" [--provider threedassets] [--limit 25]');
  const u = `/search?q=${encodeURIComponent(q)}&type=model&free=true&limit=${limit}` + (providers ? `&providers=${providers}` : '');
  const d = await api(u);
  for (const r of d.results || []) {
    const lic = r.license?.name || '?';
    const fmts = (r.formats || []).join(',');
    log(`${r.id}`);
    log(`   ${lic} · tris=${r.polyCount ?? '?'} · ${fmts || '?'}${r.downloadable ? '' : ' · 不可下载'}`);
    log(`   ${(r.description || '').slice(0, 110)}`);
  }
}

async function add() {
  const id = args[0];
  const as = flag('--as', '');
  const keys = (flag('--keys', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const tint = (flag('--tint', null));
  const rot = flag('--rot', null);
  const noFlip = has('--no-flip');
  const noTexture = has('--no-texture');
  if (!id || !as) throw new Error('用法：add <assetId> --as <slug> [--keys a,b] [--tint m1,m2] [--rot 180] [--no-flip]');

  const meta = await api(`/assets/${id}`);
  const glbFile = (meta.files || []).find((f) => f.format === 'glb');
  const io = newIO();
  let doc;
  if (glbFile) {
    log(`↓ ${meta.title} · ${meta.license?.name} · ${(glbFile.sizeBytes / 1024).toFixed(0)}KB glb`);
    const buf = Buffer.from(await (await fetch(glbFile.url)).arrayBuffer());
    doc = await io.readBinary(new Uint8Array(buf));
  } else if (meta.provider === 'polyhaven') {
    // Poly Haven 只有 gltf + 分离的 bin/贴图：自己拼一个临时目录再读，1k 档够用（随后会压 WebP）
    const files = await (await fetch(`https://api.polyhaven.com/files/${meta.nativeId}`, { headers: { 'user-agent': 'house-plan-designer/furniture3d' } })).json();
    const res = files.gltf && (files.gltf['1k'] || files.gltf[Object.keys(files.gltf)[0]]);
    const node = res && res.gltf;
    if (!node) throw new Error(`${id}: Poly Haven 没有可用的 gltf 档`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'furn-'));
    const entries = { 'model.gltf': node.url, ...Object.fromEntries(Object.entries(node.include || {}).map(([k, v]) => [k, v.url])) };
    let bytes = 0;
    for (const [rel, url] of Object.entries(entries)) {
      const p2 = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p2), { recursive: true });
      const buf2 = Buffer.from(await (await fetch(url, { headers: { 'user-agent': 'house-plan-designer/furniture3d' } })).arrayBuffer());
      bytes += buf2.length;
      writeFileAtomic(p2, buf2);
    }
    log(`↓ ${meta.title} · ${meta.license?.name} · gltf+include ${(bytes / 1024).toFixed(0)}KB（${Object.keys(entries).length} 个文件）`);
    doc = await io.read(path.join(dir, 'model.gltf'));
  } else {
    throw new Error(`${id} 没有单文件 glb（formats: ${(meta.formats || []).join(',')}），且不是 Poly Haven，暂不支持`);
  }

  // 朝向：只做 180° 翻转（靠背/床头板跑到 +Z 时转回来）。轴向不自动猜——床的长轴本来就在 Z 上，猜 90° 会把床睡反。
  let deg = rot != null ? +rot : null;
  const info0 = analyze(doc);
  if (deg == null) {
    deg = 0;
    if (has('--long-x') && info0 && info0.size[2] > info0.size[0] * 1.12) deg = 90;
    else if (!noFlip && info0 && info0.tallZ > 0.15) deg = 180;
  }
  log(`   高的一面 z=${info0.tallZ.toFixed(2)}（+1 = 靠背在 +Z）· 长轴 x/z=${info0.aspect.toFixed(2)} → 旋转 ${deg}°`);  if (deg) rotateRoots(doc, deg);

  // 归一
  await doc.transform(dequantize(), dedup(), prune());
  if (!noTexture && doc.getRoot().listTextures().length) {
    await doc.transform(textureCompress({ targetFormat: 'webp', resize: [1024, 1024], quality: 82 }));
  }
  const info = analyze(doc);
  const u = unitScale(Math.max(...info.size));
  const sizeMM = [info.size[0], info.size[1], info.size[2]].map((v) => Math.round(v * u * 1000)); // w(x) h(y) d(z)
  const out = path.join(OUT_DIR, `${as}.glb`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const bytes = await io.writeBinary(doc);
  writeFileAtomic(out, Buffer.from(bytes));

  const materials = doc.getRoot().listMaterials().map((m) => m.getName());
  const tintList = tint != null
    ? tint.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : materials.filter((m) => /fabric|upholster|velvet|linen|cushion|pillo|velour|boucle/i.test(m)).map((m) => m.toLowerCase());

  const cat = readCatalog();
  cat.models[as] = {
    file: `${as}.glb`,
    size: sizeMM,
    keys,
    tint: tintList,
    materials,
    license: meta.license?.name || '',
    attributionRequired: !!meta.license?.attributionRequired,
    credit: `${meta.title} — ${meta.author} (${meta.provider}) ${meta.license?.name || ''}`.trim(),
    source: meta.url || '',
    triangles: meta.polyCount ?? null,
  };
  writeCatalog(cat);
  log(`✓ assets/furniture/${as}.glb · ${(bytes.byteLength / 1024).toFixed(0)}KB · 真实尺寸 ${sizeMM[0]}×${sizeMM[2]}×${sizeMM[1]} (w×d×h mm)`);
  log(`   材质 ${materials.join(', ')}${tintList.length ? ` · 跟随家具颜色：${tintList.join(', ')}` : ''}`);
  if (keys.length) log(`   绑定家具 key：${keys.join(', ')}（记得 patch）`);
  else log('   还没绑定 key，用 --keys 或手改 catalog.json 后 patch');
}

async function inspect() {
  const f = args[0];
  if (!f) throw new Error('用法：inspect <file.glb>');
  const doc = await newIO().read(f);
  const info = analyze(doc);
  const u = unitScale(Math.max(...info.size));
  log(`尺寸 ${Math.round(info.size[0] * u * 1000)}×${Math.round(info.size[2] * u * 1000)}×${Math.round(info.size[1] * u * 1000)} (w×d×h mm)`);
  log(`高的一面 z=${info.tallZ.toFixed(2)} · 长轴 x/z=${info.aspect.toFixed(2)}`);
  log(`材质 ${doc.getRoot().listMaterials().map((m) => m.getName()).join(', ') || '无'}`);
  log(`三角面 ${doc.getRoot().listMeshes().reduce((n, m) => n + m.listPrimitives().reduce((k, p) => k + (p.getIndices()?.getCount() || 0) / 3, 0), 0)}`);
}

function list() {
  const cat = readCatalog();
  const ids = Object.keys(cat.models);
  if (!ids.length) return log('catalog 空的：先 add 几个模型');
  for (const id of ids) {
    const m = cat.models[id];
    const size = fs.existsSync(path.join(OUT_DIR, m.file)) ? (fs.statSync(path.join(OUT_DIR, m.file)).size / 1024).toFixed(0) + 'KB' : '缺失!';
    log(`${id.padEnd(14)} ${String(m.size[0]).padStart(4)}×${String(m.size[2]).padStart(4)}×${String(m.size[1]).padStart(4)}  ${size.padStart(6)}  keys=${(m.keys || []).join(',') || '-'}  ${m.license}`);
  }
}

// ---------- 运行时（注入 template）----------
function runtimeJS(cat, external) {
  const models = Object.entries(cat.models).map(([id, m]) => {
    let data = '';
    if (!external) {
      const p = path.join(OUT_DIR, m.file);
      if (fs.existsSync(p)) data = fs.readFileSync(p).toString('base64');
    }
    return {
      id,
      keys: m.keys || [],
      size: m.size,
      tint: (m.tint || []).map((s) => s.toLowerCase()),
      file: m.file,
      b64: data,
    };
  });
  return `${MARK_BEGIN}
/* 家具 3D 模型层：只替换可移动家具（沙发/餐桌/床/床头柜…），定制柜体、构件仍走程序化模型。
   清单由 scripts/furniture3d.mjs 生成；模型加载失败或未绑定 key 时自动退回原来的程序化模型。 */
const g3dList = ${JSON.stringify(models)};
const g3dByKey = new Map();
for (const e of g3dList) for (const k of e.keys) if (k) g3dByKey.set(k, e);
const g3dCache = new Map();
// 模型目录候选顺序：模板放在 assets/ 下时（仓库里就是 assets/template.html）根目录已经是 assets/，
// 交付的设计器则是「HTML 同级 assets/furniture/」。先试对的那个，避免先来一发 404 在控制台刷红。
const g3dDirs = (() => {
  const base = decodeURIComponent(location.pathname || '').replace(/[^/]*$/, '');
  const inAssets = base.slice(-8) === '/assets/';
  return inAssets ? ['furniture/', 'assets/furniture/', ''] : ['assets/furniture/', 'furniture/', ''];
})();
let g3dWarned = false;
function g3dEntry(t) {
  return g3dByKey.get(String(t.key || '')) || null;
}
function g3dFileHint() {
  if (g3dWarned) return;
  g3dWarned = true;
  console.warn('[家具模型] 外链模型读不到（file:// 不能跨目录取 glb），已退回程序化家具');
  if (typeof Te === 'function') Te('家具真模型要 http 打开：双击（file://）时已退回程序化家具，用「本地预览」或起个服务再看');
}
function g3dModel(e) {
  if (g3dCache.has(e.id)) return g3dCache.get(e.id);
  // file:// 下 fetch 只会抛 CORS 错误：直接当作没有模型，别在控制台刷红字
  if (!e.b64 && location.protocol === 'file:') { g3dCache.set(e.id, null); g3dFileHint(); return null; }
  if (!g3dCache.has(e.id + ':pending')) {
    g3dCache.set(e.id + ':pending', 1);
    const fetchOne = (dir) =>
      fetch(new URL(dir + e.file, document.baseURI).href).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      });
    const bytes = e.b64
      ? Promise.resolve(Uint8Array.from(atob(e.b64), (c) => c.charCodeAt(0)).buffer)
      : g3dDirs.reduce((prev, dir) => prev.catch(() => fetchOne(dir)), Promise.reject(new Error('no dir')));
    bytes
      .then((b) => rM(b))
      .then((g) => { g3dCache.set(e.id, g); g3dRebuildFor(e); })
      .catch((err) => {
        g3dCache.set(e.id, null);
        if (!g3dWarned) { g3dWarned = true; console.warn('[家具模型] 加载失败，已退回程序化模型：' + e.file, err && err.message); }
        if (location.protocol === 'file:') g3dFileHint();
      });
  }
  return null;
}
/* 模型晚于首帧加载：只调 M8()（重绘）不够 —— 家具缓存按签名复用，签名里没有“模型到位”这件事，
   于是会一直留着首帧那版程序化几何。这里把受影响家具从缓存里挑掉再重建，和设计器自己换风格的做法一致。 */
function g3dRebuildFor(e) {
  try {
    if (typeof vo === 'undefined' || typeof Yn === 'undefined' || typeof To !== 'function' || typeof k === 'undefined') { M8(); return; }
    for (const it of k.plan.furniture) {
      const en = g3dEntry(it);
      if (!en || en.id !== e.id) continue;
      const s = vo.get(it.id);
      if (!s) continue;
      Yn.remove(s.g);
      s.g.traverse((o) => { const c = o.geometry; c && !c.userData.shared && c.dispose(); });
      vo.delete(it.id);
    }
    To();
  } catch (err) { M8(); }
}
function g3dFurn(n, t) {
  const e = g3dEntry(t);
  if (!e) return false;
  const base = g3dModel(e);
  if (!base) return false;
  const g = base.clone(true);
  g.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const mat = o.material && o.material.clone ? o.material.clone() : o.material;
    if (mat && mat.color && (e.tint || []).includes(String(mat.name || '').toLowerCase())) mat.color.set(t.color);
    o.material = mat;
  });
  const s = e.size;
  if (s && s[0] > 0 && s[1] > 0 && s[2] > 0) g.scale.set((t.w / s[0]) * 1e0, (t.h / s[1]) * 1e0, (t.d / s[2]) * 1e0);
  n.add(g);
  return true;
}
/* 供验收脚本查状态：models 里 null = 加载失败（已退回程序化） */
window.__furn3d = {
  list: g3dList.map((e) => ({ id: e.id, keys: e.keys, size: e.size, embedded: !!e.b64 })),
  ready: () => g3dList.filter((e) => g3dCache.get(e.id)).map((e) => e.id),
  failed: () => g3dList.filter((e) => g3dCache.get(e.id) === null).map((e) => e.id),
  pending: () => g3dList.filter((e) => g3dCache.get(e.id + ':pending') && !g3dCache.has(e.id)).map((e) => e.id),
};
${MARK_END}`;
}

function manifestTag(cat) {
  const mini = { version: cat.version, updated: cat.updated, models: {} };
  for (const [id, m] of Object.entries(cat.models)) {
    mini.models[id] = { file: m.file, size: m.size, keys: m.keys, tint: m.tint, license: m.license, credit: m.credit, source: m.source };
  }
  return `<!--__FURN3D__--><script id="__furn3d" type="application/json">${JSON.stringify(mini).replace(/</g, '\\u003c')}</script>`;
}

function patch() {
  const tpl = path.resolve(flag('--template', TEMPLATE));
  const external = has('--external');
  const cat = readCatalog();
  const bound = Object.entries(cat.models).filter(([, m]) => (m.keys || []).length);
  if (!bound.length) throw new Error('catalog.json 里没有绑定到家具 key 的模型，先 add --keys');
  if (!external) {
    for (const [, m] of bound) if (!fs.existsSync(path.join(OUT_DIR, m.file))) throw new Error(`缺文件 ${m.file}`);
  }

  let s = fs.readFileSync(tpl, 'utf8');
  const before = s.length;
  // 运行时靠模板里的两个内部符号：rM() 解析 glb、M8() 触发重绘。它们被改名就说明模板重新打包过，必须人工看一眼。
  for (const [sym, needle] of [['rM', 'function rM('], ['M8', 'let M8'], ['vo', 'const vo=new Map'], ['Yn', 'Yn=new bt'], ['To', 'function To()']]) {
    if (!s.includes(needle)) throw new Error(`模板里找不到 ${sym}（${needle}）——重新打包后 minify 改名了，运行时注水需要同步修改`);
  }

  // 1. 清单（贴在模块脚本前面）
  s = s.replace(MANIFEST_RE, '');
  const tag = manifestTag(cat);
  const modAt = s.indexOf('<script type="module" crossorigin>');
  if (modAt < 0) throw new Error('没找到模块脚本，模板结构变了');
  s = s.slice(0, modAt) + tag + s.slice(modAt);

  // 2. 3D 家具钩子
  if (!s.includes('if(g3dFurn(n,t))')) {
    if (!s.includes(HOOK_ANCHOR)) throw new Error('没找到 yU 里的家具 switch 锚点（模板改过了）：' + HOOK_ANCHOR);
    s = s.replace(HOOK_ANCHOR, HOOK_PATCHED);
  }

  // 3. 运行时函数（追加到模块末尾，函数声明会提升）
  const re = new RegExp(escapeRe(MARK_BEGIN) + '[\\s\\S]*?' + escapeRe(MARK_END));
  if (re.test(s)) s = s.replace(re, runtimeJS(cat, external));
  else {
    const end = s.lastIndexOf('</script>');
    if (end < 0) throw new Error('没找到脚本结尾');
    s = s.slice(0, end) + '\n' + runtimeJS(cat, external) + '\n' + s.slice(end);
  }

  writeFileAtomic(tpl, s);
  const kb = (n) => (n / 1024).toFixed(0) + 'KB';
  log(`✓ 已写入 ${path.relative(ROOT, tpl)}：${kb(before)} → ${kb(s.length)}（模型${external ? '外链 assets/furniture/' : '内嵌 base64'}）`);
  for (const [id, m] of bound) log(`   ${(m.keys || []).join(',').padEnd(18)} ← ${id} (${m.size[0]}×${m.size[2]}×${m.size[1]}mm)`);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function check() {
  const tpl = path.resolve(flag('--template', TEMPLATE));
  const s = fs.readFileSync(tpl, 'utf8');
  const hasManifest = /id="__furn3d"/.test(s);
  const hasHook = s.includes('if(g3dFurn(n,t))');
  const hasRuntime = s.includes(MARK_BEGIN) && s.includes('function g3dFurn');
  const embedded = /"b64":"[A-Za-z0-9+/]{100,}/.test(s);
  log(`清单 ${hasManifest ? '✓' : '✗'} · 钩子 ${hasHook ? '✓' : '✗'} · 运行时 ${hasRuntime ? '✓' : '✗'} · ${embedded ? '模型已内嵌' : '模型走外链 assets/furniture/'} · ${(s.length / 1024).toFixed(0)}KB`);
  if (!(hasManifest && hasHook && hasRuntime)) process.exitCode = 1;
}

const table = { search, add, inspect, list, patch, check };
if (!table[cmd]) {
  console.error(`用法：node scripts/furniture3d.mjs <${Object.keys(table).join('|')}> ...`);
  process.exit(1);
}
try {
  await table[cmd]();
} catch (e) {
  console.error('✗ ' + e.message);
  process.exit(1);
}
