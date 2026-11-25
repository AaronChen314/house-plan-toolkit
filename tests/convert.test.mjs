import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runCapability} from '../src/capabilities/index.mjs';
import {openStore} from '../src/store/index.mjs';
import {detectDwgConverter} from '../src/capabilities/convert.mjs';

const BIN = fileURLToPath(new URL('../bin/space.mjs', import.meta.url));
const space = (env, ...args) => spawnSync(process.execPath, [BIN, ...args], {encoding: 'utf8', env: {...process.env, ...env}});

const DXF = `0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nWALL\n10\n0\n20\n0\n11\n1000\n21\n0\n0\nENDSEC\n0\nEOF\n`;

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-convert-'));
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({schema: 'space-project/v1', id: 'convert-demo', output: 'output'}, null, 2));
  fs.mkdirSync(path.join(dir, 'source/drawings'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'source/drawings/plan.dwg'), 'fake-dwg');
  return {dir, file: path.join(dir, 'project.json'), store: openStore(path.join(dir, 'project.json'))};
}

test('DWG 转换器检测：找不到时返回 null', () => {
  const before = process.env.ODA_CONVERTER;
  delete process.env.ODA_CONVERTER;
  try {
    // 把 PATH 清空：既找不到 ODA（本机通常没装），也找不到 dwg2dxf
    const env = {...process.env, PATH: ''};
    const result = spawnSync(process.execPath, ['-e', `
      import(${JSON.stringify(new URL('../src/capabilities/convert.mjs', import.meta.url).href)}).then(m => {
        const hit = m.detectDwgConverter();
        process.stdout.write(hit ? hit.tool : 'none');
      });
    `], {encoding: 'utf8', env});
    assert.equal(result.stdout.trim(), 'none');
  } finally {
    if (before !== undefined) process.env.ODA_CONVERTER = before;
  }
  assert.ok(detectDwgConverter() === null || typeof detectDwgConverter().tool === 'string');
});

test('缺转换器时能力给出可执行的安装提示', async () => {
  const {file} = tempProject();
  const before = process.env.PATH;
  process.env.PATH = '';
  delete process.env.ODA_CONVERTER;
  try {
    await assert.rejects(
      runCapability({project: file, capability: 'cad.convert', params: {file: 'source/drawings/plan.dwg'}}),
      (e) => {
        assert.equal(e.code, 'E_EXEC_DEPENDENCY');
        assert.match(e.message, /DWG 转换器/);
        assert.match(e.detail?.fix ?? '', /ODA|dwg2dxf/);
        return true;
      }
    );
  } finally {
    process.env.PATH = before;
  }
});

test('假转换器：产物落 output/，不污染项目根目录', {skip: process.platform === 'win32' && 'Windows 下 .cmd 不能直接 spawn'}, async () => {
  const {dir, file} = tempProject();
  const binDir = path.join(dir, 'fakebin');
  fs.mkdirSync(binDir);
  const fake = path.join(binDir, 'dwg2dxf');
  // 假 dwg2dxf：只支持 -o <out>，把固定 DXF 写过去；故意忽略输入内容
  fs.writeFileSync(fake, `#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do\n  case "$1" in\n    -o) out="$2"; shift 2 ;;\n    *) shift ;;\n  esac\ndone\n[ -n "$out" ] || exit 9\ncat > "$out" <<'DXF'\n${DXF}DXF\n`, {mode: 0o755});
  const before = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${before}`;
  try {
    const r = await runCapability({file, project: file, capability: 'cad.convert', params: {file: 'source/drawings/plan.dwg', out: 'output/cad/converted.dxf'}});
    assert.match(r.summary, /已转换/);
    assert.equal(r.data.dxf, 'output/cad/converted.dxf');
    assert.ok(fs.readFileSync(path.join(dir, 'output/cad/converted.dxf'), 'utf8').includes('ENTITIES'));
    // 工具按默认文件名落盘的场景必须不发生：项目根目录不应出现 dxf
    assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.dxf')), []);
    const {store} = tempProject();
    void store;
  } finally {
    process.env.PATH = before;
  }
});
