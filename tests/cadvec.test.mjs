import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runCapability} from '../src/capabilities/index.mjs';
import {openStore} from '../src/store/index.mjs';
import {validateModel, prepareModel} from '../src/domain/model.mjs';
import {toCadSource, toModelDraft, wallRect, openingRect, classifyOpening} from '../src/domain/cadvec.mjs';

const BIN = fileURLToPath(new URL('../bin/space.mjs', import.meta.url));
const space = (...args) => spawnSync(process.execPath, [BIN, ...args], {encoding: 'utf8'});

// cadvec 输出的最小样本（字段与 src/legacy/scripts/cadvec.py 的 cad.json 一致）
const CAD = {
  mmPerUnit: 1, scale_from: 'dxf', mmPerWmm: 1,
  walls: [
    {id: 'W1', orient: 'h', c: 0, t: 200, a: 0, b: 6000, kind: 'solid', free: false, pieces: []},
    {id: 'W2', orient: 'v', c: 0, t: 200, a: 0, b: 4000, kind: 'outline', free: false, pieces: []},
    {id: 'W3', orient: 'h', c: 4000, t: 200, a: 0, b: 6000, kind: 'hatch', free: false, pieces: []}
  ],
  openings: [
    {id: 'O1', wall: 'W1', type: 'door', s0: 2600, s1: 3400},
    {id: 'O2', wall: 'W3', type: 'window', s0: 1500, s1: 3000},
    {id: 'O3', wall: 'W2', type: 'weird', s0: 1000, s1: 1200}
  ],
  texts: [{text: '客厅', at: [1500, 2000]}, {text: '3600', at: [3000, -400]}],
  axes: [], dims: [], structs: [{kind: 'shaft', at: [5000, 3000]}]
};

test('映射：墙段、洞口的几何与类型', () => {
  assert.deepEqual(wallRect(CAD.walls[0]), [[0, -100], [6000, -100], [6000, 100], [0, 100]]);
  assert.deepEqual(wallRect(CAD.walls[1])[0], [-100, 0]);
  assert.deepEqual(openingRect(CAD.walls[0], CAD.openings[0])[0], [2600, -140]);
  assert.equal(classifyOpening({type: 'door'}), 'door');
  assert.equal(classifyOpening({type: 'slideWindow'}), 'window');
  assert.equal(classifyOpening({type: 'weird'}), 'other');
});

test('映射：cad-source 与模型草稿都是结构化实体', () => {
  const source = toCadSource(CAD, {sourceFile: 'plan.dxf'});
  assert.equal(source.schema, 'cad-source/v1');
  assert.deepEqual(source.stats, {walls: 3, doors: 1, windows: 1, texts: 2, axes: 0});
  const layers = new Set(source.entities.map(e => e.layer));
  for (const layer of ['WALL', 'DOOR', 'WINDOW', 'TEXT']) assert.ok(layers.has(layer), `缺少图层 ${layer}`);
  assert.ok(source.entities.every(e => e.provenance === 'cadvec'));

  const draft = toModelDraft(CAD);
  assert.equal(draft.floors[0].walls.length, 3);
  assert.equal(draft.floors[0].doors.length, 1);
  assert.equal(draft.floors[0].windowOpenings.length, 1);
  assert.equal(draft.floors[0].walls[0].provenance, 'cadvec');
  assert.equal(draft.floors[0].walls[0].structure, 'load-bearing', '实心墙标承重');
  assert.equal(draft.floors[0].walls[2].kind === undefined, true);
  const report = validateModel(prepareModel({...draft, projectId: 'demo'}));
  assert.equal(report.passed, true, JSON.stringify(report.issues));
});

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-cadvec-'));
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({schema: 'space-project/v1', id: 'cadvec-demo', output: 'output'}, null, 2));
  fs.mkdirSync(path.join(dir, 'source/drawings'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'source/drawings/plan.dxf'), 'fake-dxf');
  return {dir, file: path.join(dir, 'project.json')};
}

test('能力：cad.vector 产出 source + model-draft，并登记进存储', {skip: process.platform === 'win32' && '假 Python 是 shell 脚本'}, async () => {
  const {dir, file} = tempProject();
  const fake = path.join(dir, 'fakepy.sh');
  // 假 cadvec：按 --out 写 cad.json + underlay.png，并打印一行 JSON 摘要
  fs.writeFileSync(fake, `#!/bin/sh
out=""
while [ $# -gt 0 ]; do case "$1" in --out) out="$2"; shift 2;; *) shift;; esac; done
mkdir -p "$out"
cat > "$out/cad.json" <<'JSON'
${JSON.stringify(CAD)}
JSON
printf '\\211PNG\\r\\n\\032\\n' > "$out/underlay.png"
printf '%s\\n' '{"out":"x","mmPerUnit":1,"typical_wall_t":200}'
`, {mode: 0o755});
  const before = process.env.SPACE_PYTHON;
  process.env.SPACE_PYTHON = fake;
  try {
    const r = await runCapability({project: file, capability: 'cad.vector', params: {file: 'source/drawings/plan.dxf'}});
    assert.match(r.summary, /墙 3 · 门 1 · 窗 1/);
    assert.equal(r.data.stats.walls, 3);
    assert.equal(r.data.source, 'output/cad/source.json');
    assert.equal(r.data.model, 'output/cad/model-draft.json');
    assert.equal(r.data.underlay, 'output/cad/underlay.png');

    const store = openStore(file);
    assert.deepEqual(store.readJson('output/cad/source.json').stats, {walls: 3, doors: 1, windows: 1, texts: 2, axes: 0});
    assert.equal(store.readJson('output/cad/model-draft.json').floors[0].doors.length, 1);
    assert.equal(store.verify().ok, true);

    // 识别草稿直接进数据集
    const built = await runCapability({file, project: file, capability: 'dataset.build',
      params: {source: 'output/cad/source.json', id: 'd1', confirm: true, model: 'output/cad/model-draft.json'}});
    assert.equal(built.data.traces >= 0, true);
    const model = store.readJson('data/datasets/d1/model.json');
    assert.equal(model.floors[0].walls.length, 3, '识别出来的墙要进数据集模型');
    assert.equal(model.floors[0].doors.length, 1);

    // 出图链路接通
    await runCapability({file, project: file, capability: 'design.create', params: {scheme: 'a', dataset: 'd1'}});
    await runCapability({file, project: file, capability: 'design.confirm', params: {scheme: 'a', seq: 1}});
    const doc = await runCapability({file, project: file, capability: 'doc.wall-demolition', params: {scheme: 'a', seq: 1}});
    assert.match(doc.data.layers.join(','), /wall-existing/);
  } finally {
    if (before === undefined) delete process.env.SPACE_PYTHON; else process.env.SPACE_PYTHON = before;
  }
});
