// L0 契约：错误码表。四类前缀：E_DATA（数据与规则）、E_EXEC（执行与依赖）、
// E_STORE（存储与并发）、E_PUBLISH（发布边界）。表内唯一，能力只能引用表内代码。
// 项目目录校验（src/checks/layout.mjs）沿用 E0xx 编号族，不进入本表。

const define = (code, category, message, hint) => ({code, category, message, ...(hint ? {hint} : {})});

export const ERROR_CODES = [
  // 数据与规则
  define('E_DATA_SCHEMA', 'data', '数据结构或版本不符合契约', '按 schemas/ 中的定义修正，或用迁移命令升级'),
  define('E_DATA_INVALID', 'data', '数据内容不成立', '查看报告中的 issues，逐项修正'),
  define('E_DATA_REFERENCE', 'data', '引用不存在的对象或版本', '补齐上游数据集或改用有效版本'),
  define('E_DATA_RULE', 'data', '违反空间或业务规则', '按提示调整几何或参数'),
  define('E_DATA_CONFIRM_REQUIRED', 'data', '修改权威数据需要显式确认', '在 CLI 加显式开关，或在工作台逐项确认'),

  // 执行与依赖
  define('E_EXEC_PARAM', 'exec', '参数缺失或格式错误', '按能力契约修正参数'),
  define('E_EXEC_UNKNOWN_CAPABILITY', 'exec', '未注册的能力标识', '运行 space capabilities 查看清单'),
  define('E_EXEC_NOT_IMPLEMENTED', 'exec', '能力只有契约，尚未实现', '查看 space cap show <id> 里的阻塞原因'),
  define('E_EXEC_DEPENDENCY', 'exec', '缺少外部依赖（Python、Blender、Chrome 等）', '运行 space doctor 查看修复方式'),
  define('E_EXEC_PROCESS', 'exec', '外部进程执行失败', '查看日志中的退出码与标准错误'),
  define('E_EXEC_TIMEOUT', 'exec', '执行超时被回收', '缩小输入范围或提高超时上限'),
  define('E_EXEC_CANCELLED', 'exec', '执行被调用方取消', '重新提交作业'),

  // 存储与并发
  define('E_STORE_PROJECT', 'store', '项目文件缺失或不可读', '确认 --project 指向项目内的 project.json'),
  define('E_STORE_PATH', 'store', '路径超出项目范围或写入越权', '改用项目内路径；权威数据只能经 writeData 写入'),
  define('E_STORE_LOCK_REQUIRED', 'store', '修改数据未提供基准哈希', '读取时记录哈希，写入时作为 baseHash 传入'),
  define('E_STORE_CONFLICT', 'store', '基准哈希不一致，数据已被他人修改', '重新读取后再提交修改'),
  define('E_STORE_BUSY', 'store', '同一项目有未完成的写入', '等待当前写入结束后重试'),
  define('E_STORE_IO', 'store', '读写或原子提交失败', '检查磁盘空间与权限；临时文件可删除后重试'),
  define('E_STORE_VERIFY', 'store', '文件登记与磁盘内容不一致', '运行 space store rebuild 重建登记'),

  // 发布边界
  define('E_PUBLISH_LAYOUT', 'publish', '目录布局违反发布白名单', '按 publish-manifest.json 调整路径'),
  define('E_PUBLISH_DENYLIST', 'publish', '命中私有词表', '移除项目专属内容后再发布'),
  define('E_PUBLISH_ASSET', 'publish', '未登记的二进制或模型资产', '在 release 白名单的 assetManifests 中登记')
];

export const ERROR_CODE_SET = new Set(ERROR_CODES.map(e => e.code));

export function lookupError(code) {
  return ERROR_CODES.find(e => e.code === code) || null;
}

export class SpaceError extends Error {
  constructor(code, message, detail) {
    const known = lookupError(code);
    super(message || known?.message || code);
    this.name = 'SpaceError';
    this.code = code;
    this.category = known?.category || 'unknown';
    if (detail !== undefined) this.detail = detail;
  }

  toJSON() {
    return {code: this.code, category: this.category, message: this.message, ...(this.detail !== undefined ? {detail: this.detail} : {})};
  }
}

export function fail(code, message, detail) {
  if (!ERROR_CODE_SET.has(code)) throw new SpaceError('E_DATA_INVALID', `未登记的错误码：${code}`);
  return new SpaceError(code, message, detail);
}

export function isSpaceError(e) {
  return !!e && e.name === 'SpaceError' && ERROR_CODE_SET.has(e.code);
}
