import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildSkills, syncSkills, listSkills} from '../src/cli/skills.mjs';

const SKILLS = fileURLToPath(new URL('../skills/', import.meta.url));

test('技能包与 docs 单一源一致，链接可解析', () => {
  const r = buildSkills({checkOnly: true});
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(r.skills, 5);
});

test('每个技能自带 references，且 SKILL.md 不指向技能目录之外', () => {
  const names = fs.readdirSync(SKILLS, {withFileTypes: true}).filter(e => e.isDirectory()).map(e => e.name);
  assert.equal(names.length, 5);
  for (const name of names) {
    const dir = path.join(SKILLS, name);
    const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    assert.ok(fs.existsSync(path.join(dir, 'references')), `${name} 缺少 references/`);
    for (const m of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|#|mailto:)/.test(target)) continue;
      const abs = path.resolve(dir, target.split('#')[0]);
      assert.ok(fs.existsSync(abs), `${name}/SKILL.md 链接失效：${target}`);
      const rel = path.relative(SKILLS, abs).split(path.sep);
      const inside = rel[0] === name || (rel[0] !== '..' && rel[1] === 'SKILL.md');
      assert.ok(inside, `${name}/SKILL.md 指向技能目录之外：${target}`);
    }
  }
});

test('references 内不出现跨目录链接', () => {
  for (const s of listSkills()) {
    const refDir = path.join(SKILLS, s.name, 'references');
    for (const f of fs.readdirSync(refDir)) {
      if (!f.endsWith('.md')) continue;
      const text = fs.readFileSync(path.join(refDir, f), 'utf8');
      for (const m of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = m[1];
        if (/^(https?:|#|mailto:)/.test(target)) continue;
        assert.ok(!target.startsWith('../'), `${s.name}/references/${f} 含跨目录链接：${target}`);
      }
    }
  }
});

test('sync 把技能安装到项目并记录版本', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpd-skills-'));
  const r = syncSkills({project: dir});
  assert.equal(r.skills.length, 5);
  const meta = JSON.parse(fs.readFileSync(path.join(r.dest, '.skills-version'), 'utf8'));
  assert.equal(meta.version, r.version);
  assert.ok(fs.existsSync(path.join(r.dest, 'cad-to-space-data', 'references', 'structure-format.md')));
  assert.ok(!fs.existsSync(path.join(r.dest, 'skills.json')), '不应把 bundle 配置装进项目');
});
