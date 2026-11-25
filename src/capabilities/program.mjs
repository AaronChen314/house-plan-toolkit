// L3 能力：拆改可行性、净空与动线检查。只读模型出结论，不写任何文件。
import {loadProject} from '../cli/project.mjs';
import {checkCirculation, checkDemolition, checkOpenings, summarizeChecks} from '../domain/checks.mjs';

const RULE_LABELS = {model: '数据校验', demolition: '拆改', openings: '净空', circulation: '动线'};

const countOf = (issues, severity) => issues.filter(i => i.severity === severity).length;

// 读不到模型也算结论：给出可读原因，不抛异常也不留空结果。
function unreadable(message) {
  const text = `无法读取空间数据：${message}`;
  return {
    summary: text,
    outputs: [],
    data: {
      passed: false,
      issues: [{severity: 'error', code: 'model-unreadable', object: 'document', message: text}],
      byRule: {model: {errors: 1, warnings: 0}}
    }
  };
}

export const capabilities = [
  {
    id: 'program.check',
    version: '1.0.0',
    stage: 'data',
    title: '拆改与动线检查',
    description: '检查承重墙拆改、门窗洞净宽、门扇开启遮挡与入口通道净距，只读不写。',
    params: [],
    inputs: {model: 'space-model/v1'},
    outputs: {},
    sideEffects: ['none'],
    requires: [],
    idempotent: true,
    errors: ['E_DATA_INVALID', 'E_DATA_SCHEMA', 'E_DATA_RULE'],
    async run(ctx) {
      let loaded;
      try {
        loaded = loadProject(ctx.file);
      } catch (e) {
        return unreadable(e?.message || String(e));
      }

      // 模型本身的校验结论一起并入：数据不成立时，后三组规则的结果没有参考价值。
      const checks = {
        model: loaded.report,
        demolition: checkDemolition(loaded.data),
        openings: checkOpenings(loaded.data),
        circulation: checkCirculation(loaded.data)
      };
      const result = summarizeChecks(checks);
      const errors = countOf(result.issues, 'error');
      const warnings = countOf(result.issues, 'warning');
      const rules = Object.keys(checks)
        .filter(rule => checks[rule].issues?.length)
        .map(rule => `${RULE_LABELS[rule] || rule} ${checks[rule].issues.length}`)
        .join('、');
      // 模型校验不过时 merged.passed 一定为 false，所以 head 只出现在失败文案里。
      const head = loaded.report.passed ? '' : '空间数据未通过校验；';

      return {
        summary: result.passed
          ? `通过${warnings ? `，${warnings} 条提示（${rules}）` : ''}`
          : `${head}${errors} 个错误${warnings ? `、${warnings} 条提示` : ''}（${rules}）`,
        outputs: [],
        data: {passed: result.passed, issues: result.issues, byRule: result.byRule}
      };
    }
  }
];
