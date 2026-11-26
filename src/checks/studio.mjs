#!/usr/bin/env node
// 工作台视口取数的浏览器冒烟：证明首屏不再整包传图纸。
// 用法：node src/checks/studio.mjs <project.json>
// 前提：项目已建立索引（space index rebuild），或 output/cad/source.json 存在。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {launch} from './browser.mjs';
import {writeFileAtomic} from '../store/atomic.mjs';

const projectFile = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(projectFile)) {
  console.error('用法：node src/checks/studio.mjs <project.json>');
  process.exit(2);
}

const {startStudio} = await import('../server/studio.mjs');
const out = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'studio-check'));
fs.mkdirSync(out, {recursive: true});

const server = await startStudio({project: projectFile, port: 0});
const browser = await launch({viewport: {width: 1360, height: 1000}});
const requests = [];
const errors = [];

try {
  const page = await browser.newPage();
  page.on('request', r => requests.push(r.url()));
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(server.url, {waitUntil: 'networkidle0'});
  await page.waitForSelector('[data-testid="index-toggle"]', {timeout: 15000});
  // 首屏允许：能力清单、项目概览、数据集的模型（默认「数据预览」要画它，通常 <1MB）。
  // 仍然禁止：整包图纸（cad-source）——那是视口取数该负责的部分。
  const initialRequests = [...requests];
  const initialBulk = initialRequests.filter(u => /\/api\/file\?.*source\.json/.test(u));
  assert.deepEqual(initialBulk, [], `首屏请求了整包 JSON：${initialBulk.join(', ')}`);
  await page.click('[data-testid="index-toggle"]');

  await page.waitForSelector('[data-testid="index-panel"]', {timeout: 15000});
  // 没有索引时面板显示重建提示：这是合法降级，不算失败。
  const indexState = await page.evaluate(() => {
    if (document.querySelector('[data-testid="index-missing"]')) return 'missing';
    if (document.querySelector('[data-testid="index-empty"]')) return 'empty';
    if (document.querySelector('[data-testid="index-unavailable"]')) return 'unavailable';
    return 'ready';
  });
  let meta = '';
  let drawn = 0;
  if (indexState === 'ready') {
    meta = await page.waitForSelector('[data-testid="index-meta"]', {timeout: 15000}).then(el => el.evaluate(n => n.textContent));
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="index-viewport"] rect').length > 0, {timeout: 15000});
    drawn = await page.evaluate(() => document.querySelectorAll('[data-testid="index-viewport"] rect').length);
  }
  const title = await page.title();

  // 底图描图面板：有底图时出画布，没有底图时给可见提示，不能白屏。
  await page.click('[data-testid="trace-toggle"]');
  await page.waitForSelector('[data-testid="trace-panel"]', {timeout: 10000});
  const tracePanel = await page.evaluate(() => ({
    canvas: !!document.querySelector('[data-testid="trace-canvas"]'),
    empty: !!document.querySelector('[data-testid="trace-empty"]')
  }));
  assert.ok(tracePanel.canvas || tracePanel.empty, '描图面板既没有画布也没有提示');

  // 计划中的能力：门面照常显示，但只能看到「未实现」与阻塞原因，没有执行按钮。
  await page.click('[data-testid="planned-doc.mep"]');
  await page.waitForSelector('[data-testid="planned-panel"]', {timeout: 10000});
  const plannedPanel = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="planned-panel"]');
    return {
      text: panel?.textContent?.replace(/\s+/g, ' ').trim() || '',
      buttons: panel ? panel.querySelectorAll('button').length : -1
    };
  });
  assert.match(plannedPanel.text, /未实现/);
  assert.equal(plannedPanel.buttons, 0, '计划中的能力不能有执行按钮');

  // 确认清单面板：有数据集时显示状态行，没有时给出可见提示，不能白屏或报错。
  await page.click('[data-testid="confirm-toggle"]');
  await page.waitForSelector('[data-testid="confirm-panel"]', {timeout: 10000});
  // 有数据集时等状态行；没有数据集时等面板自己的空状态提示。
  await page.waitForFunction(() => document.querySelector('[data-testid="confirm-status"], [data-testid="confirm-empty"]'), {timeout: 10000});
  const confirmPanel = await page.evaluate(() => {
    const status = document.querySelector('[data-testid="confirm-status"]');
    if (status) return {mode: 'dataset', text: status.textContent.trim()};
    const empty = document.querySelector('[data-testid="confirm-empty"]');
    return {mode: empty ? 'empty' : 'none', text: (empty?.textContent || '').trim()};
  });
  assert.notEqual(confirmPanel.mode, 'none', '确认清单面板没有渲染出内容');

  // 整包图纸（cad-source）首屏与视口取数都不整份加载；只有用户点「构件核对」才主动读。
  const bulk = requests.filter(u => /\/api\/file\?.*source\.json/.test(u));
  const entityRequests = requests.filter(u => u.includes('/api/entities'));
  assert.equal(bulk.length, 0, `加载了整包图纸：${bulk.join(', ')}`);
  if (indexState === 'ready') {
    assert.ok(entityRequests.length >= 1, '没有走视口取数接口');
    assert.ok(entityRequests[0].includes('box='), '视口请求缺少包围盒');
    assert.ok(drawn > 0, '视口没有画出图元');
  }
  // 构件核对：每条线带构件类型，可按类型过滤，点线能看依据。
  await page.click('[data-testid="source-toggle"]');
  await page.waitForSelector('[data-testid="source-panel"]', {timeout: 10000});
  // 图元索引是异步读的：等画布出来或等「没有索引」的提示，别抢先判空。
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="source-panel"] svg polyline').length > 0
    || !!document.querySelector('[data-testid="source-missing"]')
    || !!document.querySelector('[data-testid="source-panel"] .banner.err'), {timeout: 15000}).catch(() => {});
  const sourcePanel = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="source-panel"]');
    const filters = [...(panel?.querySelectorAll('[data-testid="kind-filters"] label') || [])]
      .map(l => l.textContent.replace(/\s+/g, ' ').trim());
    return {
      filters,
      lines: panel ? panel.querySelectorAll('svg polyline').length : 0,
      empty: !!panel?.querySelector('[data-testid="source-missing"]')
    };
  });
  if (sourcePanel.empty) {
    console.log('构件核对：项目里还没有图元索引（cad.inspect），跳过绘制校验');
  } else {
    assert.ok(sourcePanel.filters.length > 0, '构件核对没有渲染类型过滤');
    assert.ok(sourcePanel.lines > 0, '构件核对没有画出线条');
    // 类型名必须是中文构件名，不能把内部键直接丢给用户。
    assert.ok(sourcePanel.filters.every(t => /[\u4e00-\u9fa5]/.test(t)), `类型过滤不是中文构件名：${sourcePanel.filters.join(' | ')}`);
  }
  // 点一条线：详情必须出现构件名与依据，块内图元要显示完整 id（路径/句柄）。
  const detail = await page.evaluate(() => {
    const lines = [...document.querySelectorAll('[data-testid="source-panel"] svg polyline')];
    const deep = lines.find(el => (el.dataset.id || '').includes('/')) || lines[0];
    if (!deep) return {ok: false};
    deep.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    return new Promise(resolve => setTimeout(() => {
      const box = document.querySelector('[data-testid="entity-info"]');
      resolve({ok: !!box, text: (box?.textContent || '').replace(/\s+/g, ' ').trim(), id: deep.dataset.id || ''});
    }, 400));
  });
  if (!sourcePanel.empty) {
    assert.ok(detail.ok, '点线之后没有出现图元详情');
    assert.match(detail.text, /构件/, '详情里没有构件行');
    if (detail.id.includes('/')) assert.ok(detail.text.includes(detail.id), `块内图元要显示完整 id：${detail.id}`);
  }

  const bulkAfterSource = requests.filter(u => /\/api\/file\?.*source\.json/.test(u));
  assert.ok(bulkAfterSource.length <= 1, `构件核对重复拉取整包索引：${bulkAfterSource.length} 次`);

  assert.deepEqual(errors, []);

  await page.screenshot({path: path.join(out, 'index-panel.png')});
  await page.setViewport({width: 320, height: 740});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '窄屏出现横向滚动');

  writeFileAtomic(path.join(out, 'report.json'), JSON.stringify({
    passed: true,
    project: projectFile,
    title,
    meta: meta.trim(),
    indexState,
    plannedPanel,
    tracePanel,
    drawn,
    confirmPanel,
    sourcePanel,
    detail,
    entityRequests: entityRequests.length,
    bulkRequests: bulk.length,
    errors
  }, null, 2));
  console.log(`PASS studio viewport · 索引 ${indexState} · 已绘制 ${drawn} 个图元 · 视口请求 ${entityRequests.length} 次 · 整包请求 0 次`);
} finally {
  await browser.close();
  await server.close();
}
