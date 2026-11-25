// 宿主层：命令行参数读取。命令实现只拿这个对象，不直接摸 process.argv。
export function createArgs(argv = []) {
  const rest = [...argv];

  function take(name) {
    const i = rest.indexOf(name);
    if (i < 0) return undefined;
    const value = rest[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`缺少 ${name} 的值`);
    rest.splice(i, 2);
    return value;
  }

  const flag = (name) => {
    const i = rest.indexOf(name);
    if (i >= 0) rest.splice(i, 1);
    return i >= 0;
  };

  return {
    take,
    flag,
    shift: () => rest.shift(),
    peek: () => rest[0],
    get rest() { return rest; },
    get args() { return [...rest]; }
  };
}
