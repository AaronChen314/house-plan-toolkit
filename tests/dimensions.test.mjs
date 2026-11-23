import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadProject} from '../src/cli/project.mjs';
import {validateOverrides} from '../src/space/dimensions.mjs';
const {data} = loadProject(fileURLToPath(new URL('../examples/two-level/project.json', import.meta.url)));
const key = data.floors[0].id + ':' + data.floors[0].furniture[0].id;
test('Dimensions require valid IDs, explicit positive fixed heights and appropriate fields', () => {
  assert.doesNotThrow(() => validateOverrides(data, {[key]: {cabinetRole:'low',heightMm:720}}));
  assert.throws(() => validateOverrides(data, {[key]: {cabinetRole:'low',heightMm:0}}));
  assert.throws(() => validateOverrides(data, {[key]: {sillMm:400}}));
  assert.throws(() => validateOverrides(data, {'another-project:object': {heightMm:720}}));
  assert.throws(() => validateOverrides(data, []));
});
