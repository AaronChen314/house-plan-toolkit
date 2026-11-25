import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {openStore, kindFor} from '../src/store/index.mjs';
import {writeFileAtomic, tempLeftovers} from '../src/store/atomic.mjs';
import {eventFile, registryFile} from '../src/store/events.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const projectData = (project) => ({schema: 'space-project/v1', model: null, output: 'output', ...project});

// 项目文件由测试脚手架直接落盘，存储层从空登记开始。
function tempProject(project = {id: 'store-demo'}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-store-'));
  const file = path.join(dir, 'project.json');
  fs.writeFileSync(file, JSON.stringify(projectData(project), null, 2));
  return {dir, file};
}

// 与 space init 一致：项目文件本身也经存储登记，verify 才可能全绿。
function trackedProject(project = {id: 'store-demo'}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-store-'));
  const file = path.join(dir, 'project.json');
  const data = projectData(project);
  const store = openStore(file, {create: true, project: data});
  store.writeData('project.json', JSON.stringify(data, null, 2), {baseHash: null, confirm: true, op: 'test.init', kind: 'json'});
  return {dir, file, store};
}

test('原子写入：内容正确、无残留临时文件、目标不被截断', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-atomic-'));
  const file = path.join(dir, 'a/b/c.json');
  writeFileAtomic(file, JSON.stringify({ok: true}));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {ok: true});
  writeFileAtomic(file, 'short');
  assert.equal(fs.readFileSync(file, 'utf8'), 'short', '覆盖后不应残留旧内容');
  assert.deepEqual(tempLeftovers(dir), []);
  // 目录不可写时失败，但目标原样保留且不留临时文件
  const readonly = path.join(dir, 'ro');
  fs.mkdirSync(readonly);
  writeFileAtomic(path.join(readonly, 'keep.txt'), 'original');
  fs.chmodSync(readonly, 0o500);
  assert.throws(() => writeFileAtomic(path.join(readonly, 'keep.txt'), 'new'));
  fs.chmodSync(readonly, 0o700);
  assert.equal(fs.readFileSync(path.join(readonly, 'keep.txt'), 'utf8'), 'original');
  assert.deepEqual(tempLeftovers(readonly), []);
});

test('派生物写入经存储登记并留下事件', () => {
  const {dir, file} = tempProject();
  const store = openStore(file);
  const r = store.writeArtifact('output/a.json', {n: 1}, {op: 'test.write'});
  assert.equal(r.mode, 'artifact');
  assert.equal(r.unchanged, false);
  assert.equal(store.files().files['output/a.json'].sha256, r.sha256);
  const events = store.events();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'write');
  assert.equal(events[0].op, 'test.write');
  assert.equal(events[0].path, 'output/a.json');
  assert.equal(events[0].sha256, r.sha256);
  // 内容不变时仍留痕，但不重写文件
  const mtime = fs.statSync(path.join(dir, 'output/a.json')).mtimeMs;
  const again = store.writeArtifact('output/a.json', {n: 1});
  assert.equal(again.unchanged, true);
  assert.equal(fs.statSync(path.join(dir, 'output/a.json')).mtimeMs, mtime);
  assert.equal(store.events().at(-1).status, 'unchanged');
});

test('权威数据必须带基准哈希与确认，不一致拒绝', () => {
  const {file} = tempProject();
  const store = openStore(file);
  assert.throws(() => store.writeData('data/model.json', {a: 1}), /baseHash|基准哈希/);
  assert.throws(() => store.writeData('data/model.json', {a: 1}, {baseHash: null}), /确认/);
  const first = store.writeData('data/model.json', {a: 1}, {baseHash: null, confirm: true});
  assert.equal(store.hashOf('data/model.json'), first.sha256);
  assert.throws(
    () => store.writeData('data/model.json', {a: 2}, {baseHash: 'deadbeef', confirm: true}),
    /已被修改/
  );
  const ok = store.writeData('data/model.json', {a: 2}, {baseHash: first.sha256, confirm: true});
  assert.equal(ok.unchanged, false);
  assert.equal(store.events().at(-1).baseHash, first.sha256);
});

test('派生物不能写进权威位置，路径不能越界', () => {
  const {file} = tempProject();
  const store = openStore(file);
  assert.throws(() => store.writeArtifact('data/model.json', {}), /权威位置/);
  assert.throws(() => store.writeArtifact('project.json', {}), /权威位置/);
  assert.throws(() => store.writeArtifact('../escape.json', {}), /越界/);
  assert.throws(() => store.readText('../../etc/passwd'), /越界/);
  assert.throws(() => store.writeArtifact('.space/files.json', {}), /存储内部/);
  assert.throws(() => openStore(path.join(path.dirname(file), 'missing.json')), /项目文件不存在/);
});

test('外部进程产物从暂存目录搬进项目，失败不留半成品', () => {
  const {file} = tempProject();
  const store = openStore(file);
  const staging = store.staging();
  fs.writeFileSync(path.join(staging, 'source.json'), '{"schema":"cad-source/v1","entities":[]}');
  fs.mkdirSync(path.join(staging, 'nested'));
  fs.writeFileSync(path.join(staging, 'nested', 'extra.json'), '{}');
  const written = store.ingest(staging, 'output/cad', {kind: 'cad-source'});
  assert.deepEqual(written.map(w => w.path).sort(), ['output/cad/nested/extra.json', 'output/cad/source.json']);
  assert.equal(store.readJson('output/cad/source.json').schema, 'cad-source/v1');

  const bad = store.staging();
  fs.writeFileSync(path.join(bad, 'ok.json'), '{}');
  fs.writeFileSync(path.join(bad, 'boom.json'), '{}');
  const original = store.writeArtifact.bind(store);
  let calls = 0;
  store.writeArtifact = (rel, content, opts) => {
    calls += 1;
    if (calls === 2) throw new Error('模拟写入失败');
    return original(rel, content, opts);
  };
  assert.throws(() => store.ingest(bad, 'output/bad'), /模拟写入失败/);
  assert.equal(fs.existsSync(path.join(store.dir, 'output/bad/ok.json')), false, '失败时已写文件应回滚');
});

test('内容寻址：同内容去重、可按哈希取回', () => {
  const {file} = tempProject();
  const store = openStore(file);
  const a = store.putObject('{"same":true}');
  const b = store.putObject('{"same":true}');
  assert.equal(a.sha256, b.sha256);
  assert.equal(b.deduped, true);
  assert.equal(store.getObject(a.sha256).toString('utf8'), '{"same":true}');
  assert.equal(store.getObject('f'.repeat(64)), null);
  assert.throws(() => store.getObject('not-a-hash'), /哈希格式/);
});

test('scope 记录操作名与写入次数', () => {
  const {file} = tempProject();
  const store = openStore(file);
  const scoped = store.scope('build.viewer');
  scoped.writeArtifact('output/x.json', {x: 1});
  scoped.writeArtifact('output/y.json', {y: 1});
  assert.equal(scoped.writes, 2);
  store.operation({op: 'build.viewer', status: 'done', writes: scoped.writes});
  const last = store.events().at(-1);
  assert.equal(last.type, 'op');
  assert.equal(last.writes, 2);
  assert.ok(store.events().filter(e => e.type === 'write').every(e => e.op === 'build.viewer'));
});

test('verify 发现改动与残留；rebuild 从磁盘重建且保留历史事件', () => {
  const {dir, store} = trackedProject();
  store.writeArtifact('output/a.json', {a: 1});
  store.writeArtifact('output/b.json', {b: 1});
  assert.equal(store.verify().ok, true);

  fs.writeFileSync(path.join(dir, 'output/a.json'), '{"a":2}');
  fs.writeFileSync(path.join(dir, 'output/new.json'), '{"n":1}');
  fs.writeFileSync(path.join(dir, 'output', '.tmp-half-1'), 'partial');
  const v = store.verify();
  assert.equal(v.ok, false);
  assert.deepEqual(v.modified.map(m => m.path), ['output/a.json']);
  assert.deepEqual(v.untracked, ['output/new.json']);
  assert.deepEqual(v.leftovers, ['output/.tmp-half-1']);
  assert.equal(v.checked, 3);

  const before = store.events().length;
  const r = store.rebuild();
  assert.equal(r.files, 4);
  assert.equal(store.events().length, before + 1, '重建只补一条事件，不改历史');
  assert.equal(store.events().at(-1).type, 'rebuild');
  assert.equal(store.files().files['output/new.json'].recovered, true);
  const after = store.verify();
  assert.deepEqual(after.modified, []);
  assert.deepEqual(after.untracked, []);
  assert.equal(after.ok, true);
});

test('事件日志覆盖每一次写入：登记里的每个文件都有写入事件', () => {
  const {file} = tempProject();
  const store = openStore(file);
  const scoped = store.scope('demo.capability');
  const written = [];
  for (let i = 0; i < 5; i++) written.push(scoped.writeArtifact(`output/f${i}.json`, {i}, {kind: 'json'}).path);
  store.writeData('data/m.json', {m: 1}, {baseHash: null, confirm: true, op: 'demo.capability'});
  const writes = store.events().filter(e => e.type === 'write');
  for (const rel of [...written, 'data/m.json']) {
    const matches = writes.filter(e => e.path === rel);
    assert.ok(matches.length >= 1, `${rel} 没有写入事件`);
    assert.equal(matches.at(-1).sha256, store.files().files[rel].sha256);
    assert.equal(fs.readFileSync(path.join(store.dir, rel)).length, matches.at(-1).size);
  }
  assert.equal(fs.existsSync(eventFile(store.dir)), true);
  assert.equal(fs.existsSync(registryFile(store.dir)), true);
});

test('kind 推断与项目文件位置无关', () => {
  assert.equal(kindFor('output/白模.html'), 'html');
  assert.equal(kindFor('output/model.glb'), 'model');
  assert.equal(kindFor('source/a.dxf'), 'drawing');
  assert.equal(kindFor('output/x.unknown'), 'file');
});

// M0 验收：所有写入只经存储层。这里用静态扫描卡住绕过。
const WRITE_SCAN = /(?:writeFileSync|appendFileSync|createWriteStream|appendFile)\s*\(/;
const WRITE_EXEMPT = {
  'src/store/atomic.mjs': '存储层的原子写入原语本身',
  'src/checks/white-model.mjs': '浏览器冒烟脚本，写开发用核对产物',
  'src/checks/dimensions.mjs': '浏览器冒烟脚本，写开发用核对产物'
};

function sourceFiles(dir, base = ROOT, out = []) {
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(abs, base, out);
    else if (/\.(mjs|js|jsx)$/.test(e.name)) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

test('静态扫描：除存储层与开发脚本外没有绕过存储的写入', () => {
  const offenders = [];
  for (const rel of [...sourceFiles(path.join(ROOT, 'src')), ...sourceFiles(path.join(ROOT, 'bin'))]) {
    if (rel.startsWith('src/legacy/')) continue; // 早期脚本，见 src/legacy/README.md
    if (rel.startsWith('src/viewers/') || rel.startsWith('src/studio/')) continue; // 浏览器侧，无文件系统写入
    if (WRITE_EXEMPT[rel]) continue;
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (WRITE_SCAN.test(text)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], '这些文件绕过存储层直接写文件');
  assert.deepEqual(Object.keys(WRITE_EXEMPT).sort(), ['src/checks/dimensions.mjs', 'src/checks/white-model.mjs', 'src/store/atomic.mjs']);
});

test('领域层是纯函数：不引入 IO 与进程', () => {
  const offenders = [];
  for (const rel of sourceFiles(path.join(ROOT, 'src/domain'))) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const imports = [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
    for (const spec of imports) {
      if (spec.startsWith('node:') || ['fs', 'path', 'http', 'https', 'child_process', 'os'].includes(spec)) offenders.push(`${rel} → ${spec}`);
    }
    if (/\bprocess\./.test(text)) offenders.push(`${rel} → process`);
  }
  assert.deepEqual(offenders, [], '领域层不允许依赖 IO、进程或平台 API');
});

test('派生存储：位置在 .space 内、每次提交一条汇总事件、可重建', () => {
  const {dir, store} = trackedProject();
  const index = store.derived('index');
  assert.equal(index.rel, '.space/project.sqlite');
  assert.equal(index.path, path.join(dir, '.space/project.sqlite'));
  assert.equal(index.exists(), false);

  fs.mkdirSync(path.dirname(index.path), {recursive: true});
  fs.writeFileSync(index.path, 'sqlite-bytes');
  const event = index.commit({op: 'index.rebuild', summary: {entities: 120}});
  assert.equal(event.type, 'derived');
  assert.equal(event.name, 'index');
  assert.equal(event.action, 'commit');
  assert.equal(event.bytes, 'sqlite-bytes'.length);
  assert.deepEqual(event.summary, {entities: 120});
  assert.equal(store.files().files['.space/project.sqlite'], undefined, '派生库不进文件登记');
  assert.equal(store.verify().ok, true, '派生库不影响 verify');

  index.reset();
  assert.equal(index.exists(), false);
  assert.equal(store.events().at(-1).action, 'reset');
  assert.throws(() => store.derived('not-registered'), /未登记的派生存储/);
  assert.equal(store.derived('cache').rel, '.space/cache');
});

test('命令注册表：命令与别名唯一、都有分组与用法', async () => {
  const {COMMANDS, validateCommands, findCommand, helpText} = await import('../src/cli/registry.mjs');
  assert.deepEqual(validateCommands(), []);
  assert.ok(COMMANDS.length >= 20);
  assert.equal(findCommand('verify:public')?.name, 'verify-public');
  assert.equal(findCommand('--version')?.name, 'version');
  assert.equal(findCommand('nope'), null);
  const help = helpText();
  for (const c of COMMANDS.filter(c => !c.hidden)) assert.ok(help.includes(c.usage), `帮助缺少 ${c.name}`);
});
