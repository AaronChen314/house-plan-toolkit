// 解析要用的 Python：显式变量 → 项目 .space/venv → 包内 .venv → python3。
import fs from 'node:fs';
import path from 'node:path';
import {ROOT} from '../root.mjs';

export function findPython(projectDir) {
  const exe = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
  const candidates = [
    process.env.SPACE_PYTHON,
    projectDir ? path.join(projectDir, '.space', 'venv', exe) : null,
    path.join(ROOT, '.venv', exe),
    process.platform === 'win32' ? 'python' : 'python3'
  ].filter(Boolean);
  return candidates.find(p => p === 'python3' || p === 'python' || fs.existsSync(p)) || 'python3';
}
