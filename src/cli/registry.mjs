// 宿主层：命令注册表。CLI 帮助、参数解析与退出码都由这里生成。
// 新增命令 = 新增 commands/<域>.mjs + 这里各加一行 import 与一个展开项，改动是纯追加。
import {VERSION} from '../root.mjs';
import {commands as projectCommands} from './commands/project.mjs';
import {commands as storeCommands} from './commands/store.mjs';
import {commands as indexCommands} from './commands/index.mjs';
import {commands as graphCommands} from './commands/graph.mjs';
import {commands as datasetCommands} from './commands/dataset.mjs';
import {commands as designCommands} from './commands/design.mjs';
import {commands as programCommands} from './commands/program.mjs';
import {commands as annotationCommands} from './commands/annotation.mjs';
import {commands as traceCommands} from './commands/trace.mjs';
import {commands as docCommands} from './commands/doc.mjs';
import {commands as deliveryCommands} from './commands/delivery.mjs';
import {commands as capCommands} from './commands/cap.mjs';
import {commands as pluginCommands} from './commands/plugin.mjs';
import {commands as sourceCommands} from './commands/source.mjs';
import {commands as assetsCommands} from './commands/assets.mjs';
import {commands as pipelineCommands} from './commands/pipeline.mjs';
import {commands as envCommands} from './commands/env.mjs';

export const COMMANDS = [
  ...projectCommands,
  ...storeCommands,
  ...indexCommands,
  ...graphCommands,
  ...datasetCommands,
  ...designCommands,
  ...programCommands,
  ...annotationCommands,
  ...traceCommands,
  ...docCommands,
  ...deliveryCommands,
  ...capCommands,
  ...pluginCommands,
  ...sourceCommands,
  ...assetsCommands,
  ...pipelineCommands,
  ...envCommands
];

export const HELP_GROUPS = ['项目', '数据', '设计', '交付', '图纸与资产', '技能与环境', '其他'];

export function findCommand(name) {
  if (!name) return null;
  return COMMANDS.find(c => c.name === name || (c.aliases || []).includes(name)) || null;
}

export function commandIndex() {
  return COMMANDS.map(({name, aliases = [], group, usage, summary}) => ({name, aliases, group, usage, summary}));
}

const USAGE_COLUMN = 58;

export function helpText() {
  const lines = [`house-plan-toolkit ${VERSION}`, ''];
  for (const group of HELP_GROUPS) {
    const items = COMMANDS.filter(c => c.group === group && !c.hidden);
    if (!items.length) continue;
    lines.push(group);
    for (const c of items) {
      // 用法过长时说明换行，避免两段文字粘在一起。
      if (c.usage.length >= USAGE_COLUMN) {
        lines.push(`  ${c.usage}`);
        if (c.summary) lines.push(`${' '.repeat(USAGE_COLUMN + 2)}${c.summary}`);
      } else {
        lines.push(`  ${c.usage.padEnd(USAGE_COLUMN)}${c.summary}`.trimEnd());
      }
    }
    lines.push('');
  }
  lines.push('space help | tools | run <tool-name> ...');
  return lines.join('\n');
}

// 注册表自检：命令名唯一、必须分到已有分组、必须写明用法。
export function validateCommands() {
  const problems = [];
  const names = new Set();
  for (const c of COMMANDS) {
    for (const name of [c.name, ...(c.aliases || [])]) {
      if (names.has(name)) problems.push(`命令或别名重复：${name}`);
      names.add(name);
    }
    if (!HELP_GROUPS.includes(c.group)) problems.push(`${c.name}: 未分组（${c.group}）`);
    if (!c.usage || !c.usage.startsWith('space ')) problems.push(`${c.name}: usage 需以 "space " 开头`);
    if (typeof c.run !== 'function') problems.push(`${c.name}: 缺少 run`);
  }
  return problems;
}
