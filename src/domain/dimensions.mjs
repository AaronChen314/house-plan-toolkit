// L1 领域：用户可编辑的尺寸层校验。确认值只能是数据，不是计算。
export function validateOverrides(data, overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Expected an overrides object');
  const objects = new Map(data.floors.flatMap(f => [
    ...(f.furniture || []).filter(i => i.kind === 'cabinet'),
    ...(f.doors || []),
    ...(f.windowOpenings || [])
  ].map(i => [f.id + ':' + i.id, i])));

  for (const [key, values] of Object.entries(overrides)) {
    const original = objects.get(key);
    if (!original) throw new Error('Unknown object: ' + key);
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid dimensions: ' + key);
    const allowed = original.kind === 'cabinet' ? ['cabinetRole', 'heightMm']
      : original.kind === 'window' ? ['sillMm', 'headMm']
      : ['heightMm'];
    for (const [field, value] of Object.entries(values)) {
      if (!allowed.includes(field)) throw new Error('Invalid field: ' + key + '.' + field);
      if (field === 'cabinetRole') {
        if (!['full', 'counter', 'low', 'bar', 'appliance'].includes(value)) throw new Error('Invalid cabinet role: ' + key);
      } else if (!Number.isFinite(value) || value < 0 || value > 100000) {
        throw new Error('Invalid dimension: ' + key + '.' + field);
      }
    }
    const item = {...original, ...values};
    if (item.kind === 'window' && !(item.headMm > item.sillMm && item.sillMm >= 0)) throw new Error('Window head must be above sill: ' + key);
    if (item.kind !== 'window' && item.cabinetRole !== 'full' && !(item.heightMm > 0)) throw new Error('Positive height required: ' + key);
  }
  return overrides;
}
