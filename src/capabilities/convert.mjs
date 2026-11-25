// L3 能力：DWG → DXF。DWG 是二进制闭源格式，工具包不自己解析，只调用外部转换器。
// 检测顺序固定：ODA File Converter（保真最好）→ LibreDWG 的 dwg2dxf。都没有就报依赖缺失。
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fail} from '../contracts/errors.mjs';
import {relOf} from './context.mjs';

const ODA_CANDIDATES = [
  process.env.ODA_CONVERTER,
  '/Applications/ODAFileConverter.app/Contents/MacOS/ODAFileConverter',
  '/Applications/ODAFileConverter 25.4.0.app/Contents/MacOS/ODAFileConverter',
  'C:/Program Files/ODA/ODAFileConverter/ODAFileConverter.exe',
  '/usr/bin/ODAFileConverter',
  '/opt/ODAFileConverter/ODAFileConverter'
].filter(Boolean);

function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], {encoding: 'utf8'});
  return r.status === 0 ? String(r.stdout).trim().split(/\r?\n/)[0] : null;
}

export function detectDwgConverter() {
  for (const candidate of ODA_CANDIDATES) {
    try { if (candidate && fs.statSync(candidate).isFile()) return {tool: 'oda', path: candidate}; } catch {}
  }
  const libredwg = which('dwg2dxf');
  if (libredwg) return {tool: 'libredwg', path: libredwg};
  return null;
}

export const capabilities = [
  {
    id: 'cad.convert',
    version: '1.0.0',
    stage: 'source',
    title: 'DWG 转 DXF',
    description: '调用本机转换器把 DWG 转成 DXF，产物写到 output/cad/，再交给 cad.inspect 解析。',
    params: [
      {key: 'file', label: 'DWG 文件', type: 'path', required: true, accept: '.dwg'},
      {key: 'out', label: '输出 DXF', type: 'text', default: 'output/cad/converted.dxf'},
      {key: 'dwgVersion', label: 'DWG 版本（ODA 用）', type: 'select', options: ['ACAD2018', 'ACAD2013', 'ACAD2010', 'ACAD2007'], default: 'ACAD2018'},
      {key: 'dxfVersion', label: 'DXF 版本（ODA 用）', type: 'select', options: ['ACAD2018', 'ACAD2013', 'ACAD2010', 'ACAD2007'], default: 'ACAD2018'}
    ],
    inputs: {file: 'path:dwg'},
    outputs: {dxf: 'path:dxf'},
    sideEffects: ['write:artifact'],
    requires: ['node:odaconverter'],
    idempotent: true,
    errors: ['E_EXEC_PARAM', 'E_EXEC_DEPENDENCY', 'E_EXEC_PROCESS', 'E_STORE_PATH', 'E_STORE_IO'],
    async run(ctx, {file, out = 'output/cad/converted.dxf', dwgVersion = 'ACAD2018', dxfVersion = 'ACAD2018'} = {}) {
      const src = ctx.store.resolve(file);
      if (!fs.existsSync(src)) throw fail('E_EXEC_PARAM', `文件不存在：${file}`);
      if (!/\.dwg$/i.test(src)) throw fail('E_EXEC_PARAM', '需要 .dwg 文件');

      const converter = detectDwgConverter();
      if (!converter) {
        throw fail('E_EXEC_DEPENDENCY', '没有找到 DWG 转换器', {
          fix: '安装 ODA File Converter（免费，需注册下载），或 brew install libredwg 后用 dwg2dxf；也可以用 CAD 软件另存为 DXF',
          checked: ODA_CANDIDATES
        });
      }

      const target = ctx.store.resolve(out);
      if (!target.startsWith(ctx.outputDir)) throw fail('E_STORE_PATH', `输出必须落在 output/：${out}`);
      const staging = ctx.store.staging();
      const work = path.join(staging, 'in');
      fs.mkdirSync(work, {recursive: true});
      const local = path.join(work, path.basename(src));
      fs.copyFileSync(src, local);

      ctx.log(`$ ${converter.tool} ${path.basename(src)}`);
      if (converter.tool === 'oda') {
        // ODAFileConverter <in> <out> <inVer> <outVer> <recurse 0/1> <audit 0/1> [filter]
        const outDir = path.join(staging, 'out');
        fs.mkdirSync(outDir, {recursive: true});
        const r = spawnSync(converter.path, [work, outDir, dwgVersion, dxfVersion, '0', '1', '*.DWG'], {encoding: 'utf8', cwd: staging});
        if (r.error) throw fail('E_EXEC_DEPENDENCY', `无法执行 ODAFileConverter：${r.error.message}`);
        if (r.status !== 0) throw fail('E_EXEC_PROCESS', `ODAFileConverter 退出码 ${r.status}：${(r.stderr || '').slice(0, 300)}`);
        const produced = fs.readdirSync(outDir).find(f => /\.dxf$/i.test(f));
        if (!produced) throw fail('E_EXEC_PROCESS', 'ODAFileConverter 没有产出 DXF');
        fs.renameSync(path.join(outDir, produced), path.join(staging, 'converted.dxf'));
      } else {
        // LibreDWG：输出必须用 -o 指定；-y 允许覆盖。cwd 放在暂存目录，
        // 防止工具在项目里按默认文件名落一个 DXF（那是绕过存储层的写入）。
        const asVersion = `r${String(dxfVersion).replace(/^ACAD/i, '')}`;
        const r = spawnSync(converter.path, ['-y', '--as', asVersion, '-o', path.join(staging, 'converted.dxf'), local], {encoding: 'utf8', cwd: staging});
        if (r.error) throw fail('E_EXEC_DEPENDENCY', `无法执行 dwg2dxf：${r.error.message}`);
        if (r.status !== 0) throw fail('E_EXEC_PROCESS', `dwg2dxf 退出码 ${r.status}：${(r.stderr || '').slice(0, 300)}`);
      }

      const converted = path.join(staging, 'converted.dxf');
      if (!fs.existsSync(converted)) throw fail('E_EXEC_PROCESS', '转换没有产出 DXF');
      const written = ctx.store.writeArtifact(relOf(ctx.dir, target), fs.readFileSync(converted), {kind: 'drawing'});
      fs.rmSync(staging, {recursive: true, force: true});

      const caveat = converter.tool === 'libredwg'
        ? '；注意：LibreDWG 的 DXF 输出兼容性差（实测 ezdxf 读不了），建议改用 ODA File Converter'
        : '';
      return {
        summary: `已转换（${converter.tool}）：${written.path}${caveat}`,
        outputs: [{path: written.path, kind: 'drawing'}],
        data: {tool: converter.tool, dxf: written.path, bytes: written.size}
      };
    }
  }
];
