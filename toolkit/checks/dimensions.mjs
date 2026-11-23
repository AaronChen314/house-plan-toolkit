import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {launch, setDownloadDir} from './browser.mjs';

const file = path.resolve(process.argv[2]);
const out = path.join(path.dirname(file), 'dimension-check');
fs.mkdirSync(out, {recursive: true});
const html = fs.readFileSync(file, 'utf8');
// Two pages on the same origin prove that storage keys, not file origins, isolate projects.
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(req.url === '/other' ? html.replaceAll('two-level-example', 'another-example') : html);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await setDownloadDir(browser, page, out);
  await page.goto(base);
  await page.waitForFunction(() => window.whiteModel?.state);
  await page.$eval('#dimensionSettings details', el => el.open = true);
  await page.select('#cabinetRole', 'low');
  await page.$eval('#dimensionHeight', el => {el.value = '720'; el.dispatchEvent(new Event('change'));});
  await page.reload();
  await page.waitForFunction(() => window.whiteModel?.state);
  await page.$eval('#dimensionSettings details', el => el.open = true);
  assert.equal(await page.$eval('#dimensionHeight', el => +el.value), 720);
  const exported = path.join(out, 'two-level-example-柜体门窗参数.json');
  fs.rmSync(exported, {force:true});
  await page.click('#dimensionExport');
  let doc;
  for (let i = 0; i < 100; i++) {
    try { doc = JSON.parse(fs.readFileSync(exported, 'utf8')); break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert(doc, 'Dimension JSON download did not finish');
  assert.equal(doc.projectId, 'two-level-example');
  await page.click('#dimensionReset');
  assert.notEqual(await page.$eval('#dimensionHeight', el => +el.value), 720);
  await (await page.$('#dimensionImport')).uploadFile(exported);
  await page.waitForFunction(() => document.querySelector('#dimensionNote').textContent.includes('已导入'));
  assert.equal(await page.$eval('#dimensionHeight', el => +el.value), 720);
  await page.goto(base + '/other');
  await page.waitForFunction(() => window.whiteModel?.state);
  await page.$eval('#dimensionSettings details', el => el.open = true);
  assert.notEqual(await page.$eval('#dimensionHeight', el => +el.value), 720);
  await (await page.$('#dimensionImport')).uploadFile(exported);
  await page.waitForFunction(() => document.querySelector('#dimensionNote').textContent.includes('different project'));
  assert.notEqual(await page.$eval('#dimensionHeight', el => +el.value), 720);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({passed:true,persistence:true,exportImport:true,sameOriginProjectIsolation:true,errors}, null, 2));
  console.log('PASS dimension persistence, export/import and project isolation');
} finally {
  await browser.close();
  server.close();
}
