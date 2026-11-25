// L0 契约：传输格式。CLI 退出码与 JSON 输出、工作台请求与事件流、
// 跨语言 worker 的消息帧都按这里定义，宿主不各自发明。

export const EXIT = {
  OK: 0,
  FAIL: 1,
  USAGE: 2
};

// 能力结果的统一外壳。ok 由调用方设置，能力本身只返回 summary/outputs/data。
export const RESULT_FIELDS = ['ok', 'capability', 'title', 'summary', 'outputs', 'data', 'logs'];

export function capabilityResult({capability, title, summary, outputs = [], data}) {
  return {ok: true, capability, title, summary, outputs, data};
}

export function failureResult(error, {capability} = {}) {
  const e = error && typeof error === 'object' ? error : {message: String(error)};
  return {
    ok: false,
    ...(capability ? {capability} : {}),
    error: {code: e.code || 'E_EXEC_PROCESS', category: e.category || 'exec', message: e.message || String(error), ...(e.detail !== undefined ? {detail: e.detail} : {})}
  };
}

export function exitCodeFor(result) {
  if (!result) return EXIT.FAIL;
  if (result.ok === false) return result.error?.category === 'exec' && result.error?.code === 'E_EXEC_PARAM' ? EXIT.USAGE : EXIT.FAIL;
  return EXIT.OK;
}

// 工作台事件流：一个请求对应一条作业，进度与结束都以帧的形式下发。
export const JOB_STATES = ['queued', 'running', 'done', 'failed', 'cancelled'];

export function jobFrame(type, payload = {}) {
  if (!['progress', 'result', 'error', 'log'].includes(type)) throw new Error(`未知作业帧：${type}`);
  return {schema: 'space-job/v1', type, at: new Date().toISOString(), ...payload};
}

// worker 消息：按行分隔的 JSON，Python 与 Blender 共用。
export const WORKER_FRAMES = ['request', 'progress', 'result', 'error'];

export function workerFrame(type, payload = {}) {
  if (!WORKER_FRAMES.includes(type)) throw new Error(`未知 worker 帧：${type}`);
  return JSON.stringify({schema: 'space-worker/v1', type, ...payload});
}

export function parseWorkerFrame(line) {
  let value;
  try { value = JSON.parse(line); } catch { return {type: 'log', text: line}; }
  if (!value || typeof value !== 'object') return {type: 'log', text: line};
  if (value.schema !== 'space-worker/v1' || !WORKER_FRAMES.includes(value.type)) return {type: 'log', text: line, raw: value};
  return value;
}
