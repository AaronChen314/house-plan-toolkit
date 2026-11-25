// L2 存储：项目存储的唯一写入入口。
// 文件是事实源，.space/ 是派生索引与日志；所有写入都经这里，能力不直接碰 fs。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fail} from '../contracts/errors.mjs';
import {ARTIFACT_ROOTS, artifactBlocked, derivedSpec, writeModeFor} from '../contracts/store.mjs';
import {ensureDir, hashFile, readJson, readText, sha256, TEMP_PREFIX, tempLeftovers, toPosix, walkFiles, writeFileAtomic} from './atomic.mjs';
import {appendEvent, emptyRegistry, eventFile, readEvents, registryFile, withProjectLock, writeRegistry} from './events.mjs';
import {getObject, objectStats, putObject, relOf} from './objects.mjs';

const SKIP_DIRS = ['.space', 'node_modules', '.git', '__pycache__', '.venv', 'venv'];

const KIND_BY_EXT = {
  '.html': 'html', '.htm': 'html', '.json': 'json', '.md': 'doc', '.txt': 'text',
  '.glb': 'model', '.gltf': 'model', '.fbx': 'model', '.obj': 'model', '.blend': 'model',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.svg': 'image',
  '.zip': 'bundle', '.dxf': 'drawing', '.dwg': 'drawing', '.pdf': 'document'
};

export function kindFor(rel) {
  return KIND_BY_EXT[path.extname(rel).toLowerCase()] || 'file';
}

function toBuffer(content) {
  if (Buffer.isBuffer(content)) return content;
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  return Buffer.from(JSON.stringify(content, null, 2) + '\n', 'utf8');
}

function readRegistryOrEmpty(dir, projectId) {
  try {
    const reg = readJson(registryFile(dir));
    if (reg?.schema === 'space-files/v1') return reg;
  } catch {}
  return emptyRegistry(projectId);
}

export function openStore(projectFile, opts = {}) {
  const projectFileAbs = path.resolve(projectFile);
  const dir = path.dirname(projectFileAbs);
  const actor = opts.actor || process.env.SPACE_ACTOR || 'cli';
  let project = opts.project || null;
  let projectId = project?.id || null;

  if (fs.existsSync(projectFileAbs)) {
    project = JSON.parse(readText(projectFileAbs));
    if (project.schema !== 'space-project/v1') {
      throw fail('E_DATA_SCHEMA', `${projectFileAbs} 不是 space-project/v1`);
    }
    projectId = project.id || projectId;
  } else if (!opts.create) {
    throw fail('E_STORE_PROJECT', `项目文件不存在：${projectFileAbs}`);
  }

  // 登记表带 mtime 戳：同进程里可能有多个 store 实例（能力自己开一个、宿主也开一个），
  // 谁后写谁生效，读的一方必须能看到对方的更新，否则 verify 会对着旧值误报。
  let registry = null;
  let registryStamp = null;
  const stampOfRegistry = () => {
    try {
      const st = fs.statSync(registryFile(dir));
      return `${st.mtimeMs}:${st.size}`;
    } catch { return null; }
  };
  const reg = () => {
    const stamp = stampOfRegistry();
    if (!registry || stamp !== registryStamp) {
      registry = readRegistryOrEmpty(dir, projectId);
      registryStamp = stamp;
    }
    return registry;
  };
  const saveRegistry = () => {
    // 不能用 reg()：它可能因为 mtime 变化重新加载，把调用方刚写进去的条目丢掉。
    if (!registry) registry = readRegistryOrEmpty(dir, projectId);
    const r = registry;
    r.project = projectId;
    r.updatedAt = new Date().toISOString();
    writeRegistry(dir, r);
    registryStamp = stampOfRegistry();
    return r;
  };

  const guard = (rel, {allowSpace = false} = {}) => {
    if (typeof rel !== 'string' || !rel.trim()) throw fail('E_EXEC_PARAM', '路径不能为空');
    const abs = path.resolve(dir, rel);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) throw fail('E_STORE_PATH', `路径越界：${rel}`);
    const posix = toPosix(path.relative(dir, abs));
    if (!posix) throw fail('E_STORE_PATH', '路径必须指向项目内的文件');
    if (!allowSpace && (posix === '.space' || posix.startsWith('.space/'))) {
      throw fail('E_STORE_PATH', `存储内部目录不通过公开写入接口修改：${posix}`);
    }
    return {abs, rel: posix};
  };

  const absOf = (rel) => guard(rel).abs;

  function record(entry) {
    const r = reg();
    r.files[entry.path] = {
      sha256: entry.sha256,
      size: entry.size,
      mode: entry.mode,
      kind: entry.kind,
      at: entry.at
    };
    saveRegistry();
  }

  function write(rel, content, {mode, kind, op, params, baseHash, force = false, confirm = false} = {}) {
    const target = guard(rel);
    const buf = toBuffer(content);
    const digest = sha256(buf);
    const effectiveMode = mode || writeModeFor(target.rel);
    const at = new Date().toISOString();

    return withProjectLock(dir, () => {
      const exists = fs.existsSync(target.abs);
      const current = exists ? hashFile(target.abs) : null;

      if (effectiveMode === 'data') {
        if (baseHash === undefined) {
          throw fail('E_STORE_LOCK_REQUIRED', `${target.rel}：修改权威数据必须带读取时的 baseHash`, {path: target.rel});
        }
        if (!confirm) {
          throw fail('E_DATA_CONFIRM_REQUIRED', `${target.rel}：修改权威数据需要显式确认`, {path: target.rel});
        }
        if (!force && baseHash !== current) {
          throw fail('E_STORE_CONFLICT', `${target.rel} 已被修改：基准 ${baseHash ?? '不存在'}，磁盘 ${current ?? '不存在'}`, {path: target.rel, baseHash, current});
        }
      }

      const unchanged = current === digest;
      if (!unchanged) writeFileAtomic(target.abs, buf);
      const size = buf.length;
      record({path: target.rel, sha256: digest, size, mode: effectiveMode, kind: kind || kindFor(target.rel), at});
      appendEvent(dir, {
        type: 'write',
        mode: effectiveMode,
        op: op || 'store.write',
        path: target.rel,
        sha256: digest,
        size,
        kind: kind || kindFor(target.rel),
        status: unchanged ? 'unchanged' : 'written',
        ...(baseHash !== undefined ? {baseHash} : {}),
        ...(force ? {forced: true} : {}),
        ...(params ? {params} : {}),
        actor
      });
      return {path: target.rel, sha256: digest, size, mode: effectiveMode, unchanged};
    });
  }

  const store = {
    dir,
    projectFile: projectFileAbs,
    actor,
    get project() { return project; },
    get projectId() { return projectId; },
    stateDir: path.join(dir, '.space'),
    eventFile: eventFile(dir),
    registryFile: registryFile(dir),

    rel: (abs) => relOf(dir, path.resolve(abs)),
    resolve: (rel) => absOf(rel),
    exists(rel) {
      return fs.existsSync(absOf(rel));
    },
    readText(rel) {
      return readText(absOf(rel));
    },
    readJson(rel) {
      return JSON.parse(readText(absOf(rel)));
    },
    readBuffer(rel) {
      return fs.readFileSync(absOf(rel));
    },
    hashOf(rel) {
      const abs = absOf(rel);
      return fs.existsSync(abs) ? hashFile(abs) : null;
    },
    staging() {
      const base = path.join(dir, '.space', 'tmp', crypto.randomBytes(6).toString('hex'));
      return ensureDir(base);
    },
    writeArtifact(rel, content, o = {}) {
      const posix = guard(rel).rel;
      if (artifactBlocked(posix)) {
        throw fail('E_STORE_PATH', `${posix} 属于权威位置，改用 writeData`, {path: posix});
      }
      return write(posix, content, {...o, mode: 'artifact'});
    },
    writeData(rel, content, o = {}) {
      const posix = guard(rel).rel;
      const top = posix.split('/')[0];
      if (ARTIFACT_ROOTS.includes(top) && !o.allowArtifactRoot) {
        throw fail('E_STORE_PATH', `${posix} 是派生物目录，改用 writeArtifact`, {path: posix});
      }
      return write(posix, content, {...o, mode: 'data'});
    },
    // 外部进程（Python、Blender）只能写临时目录，产物由这里搬进项目。
    ingest(stagingDir, relDir, o = {}) {
      const files = walkFiles(stagingDir, stagingDir);
      const written = [];
      try {
        for (const rel of files) {
          const buf = fs.readFileSync(path.join(stagingDir, rel));
          const target = toPosix(path.join(relDir || '.', rel));
          written.push(store.writeArtifact(target, buf, o));
        }
        return written;
      } catch (e) {
        for (const w of written) {
          try { fs.rmSync(path.join(dir, w.path), {force: true}); } catch {}
        }
        throw e;
      }
    },
    putObject(buffer, o = {}) {
      const result = putObject(dir, buffer);
      appendEvent(dir, {type: 'write', mode: 'object', op: o.op || 'store.object', path: result.rel, sha256: result.sha256, status: result.deduped ? 'deduped' : 'written', actor});
      return result;
    },
    getObject(digest) {
      return getObject(dir, digest);
    },
    files() {
      return reg();
    },
    // 派生存储句柄：文件自己管，位置、项目锁与汇总事件由存储层管。
    derived(name) {
      const spec = derivedSpec(name);
      if (!spec) throw fail('E_EXEC_PARAM', `未登记的派生存储：${name}`);
      const target = path.join(dir, spec.path);
      const handle = {
        name,
        path: target,
        rel: relOf(dir, target),
        exists: () => fs.existsSync(target),
        stat() {
          try {
            const st = fs.statSync(target);
            return {bytes: st.size, modifiedAt: st.mtime.toISOString()};
          } catch { return null; }
        },
        reset(o = {}) {
          return withProjectLock(dir, () => {
            // SQLite 的 -wal / -shm 是同一次写入留下的，一起清掉。
            for (const suffix of ['', '-wal', '-shm']) {
              try { fs.rmSync(`${target}${suffix}`, {recursive: true, force: true}); } catch {}
            }
            return appendEvent(dir, {type: 'derived', op: o.op || 'store.derived.reset', name, action: 'reset', actor});
          });
        },
        commit(o = {}) {
          return withProjectLock(dir, () => appendEvent(dir, {
            type: 'derived',
            op: o.op || 'store.derived.commit',
            name,
            action: 'commit',
            ...handle.stat(),
            ...(o.summary ? {summary: o.summary} : {}),
            actor
          }));
        }
      };
      return handle;
    },
    // 操作事件：没有写入的能力也要留痕，事件日志覆盖每一次操作。
    operation(event = {}) {
      return appendEvent(dir, {type: 'op', actor, ...event});
    },
    events(o = {}) {
      return readEvents(dir, o);
    },
    verify() {
      const r = reg();
      const missing = [], modified = [];
      for (const [rel, entry] of Object.entries(r.files)) {
        const abs = path.join(dir, rel);
        if (!fs.existsSync(abs)) { missing.push(rel); continue; }
        const actual = hashFile(abs);
        if (actual !== entry.sha256) modified.push({path: rel, expected: entry.sha256, actual});
      }
      const onDisk = walkFiles(dir, dir, [], {skip: SKIP_DIRS});
      const leftovers = tempLeftovers(dir).map(f => relOf(dir, f));
      // 残留临时文件单列，不混进「未登记」清单。
      const untracked = onDisk.filter(rel => !r.files[rel] && !path.basename(rel).startsWith(TEMP_PREFIX));
      return {
        ok: missing.length === 0 && modified.length === 0 && leftovers.length === 0,
        project: projectId,
        checked: Object.keys(r.files).length,
        onDisk: onDisk.length,
        missing,
        modified,
        untracked,
        leftovers,
        objects: objectStats(dir),
        events: readEvents(dir).length
      };
    },
    rebuild(o = {}) {
      // 中断留下的临时文件属于存储层自己的残留，重建时清掉。
      const cleaned = tempLeftovers(dir).map(f => relOf(dir, f));
      for (const rel of cleaned) {
        try { fs.rmSync(path.join(dir, rel), {force: true}); } catch {}
      }
      const onDisk = walkFiles(dir, dir, [], {skip: SKIP_DIRS});
      const at = new Date().toISOString();
      const files = {};
      for (const rel of onDisk) {
        const abs = path.join(dir, rel);
        const mode = writeModeFor(rel);
        files[rel] = {sha256: hashFile(abs), size: fs.statSync(abs).size, mode, kind: kindFor(rel), at, recovered: true};
      }
      registry = {schema: 'space-files/v1', project: projectId, updatedAt: at, files};
      saveRegistry();
      appendEvent(dir, {type: 'rebuild', op: o.op || 'store.rebuild', files: Object.keys(files).length, cleaned, actor, ...(o.reason ? {reason: o.reason} : {})});
      return {project: projectId, files: Object.keys(files).length, cleaned, events: readEvents(dir).length};
    },
    scope(op) {
      const scoped = Object.create(store);
      scoped.op = op;
      scoped.writes = 0;
      for (const m of ['writeArtifact', 'writeData', 'ingest']) {
        scoped[m] = (a, b, c) => {
          const raw = store[m](a, b, {...(c || {}), op: (c && c.op) || op});
          const count = Array.isArray(raw) ? raw.length : 1;
          scoped.writes += count;
          return raw;
        };
      }
      return scoped;
    }
  };

  return store;
}

export function openProjectStore(projectFile, opts) {
  return openStore(projectFile, opts);
}

export function storeSummary(store) {
  const reg = store.files();
  return {
    project: store.projectId,
    dir: store.dir,
    files: Object.keys(reg.files).length,
    artifacts: Object.values(reg.files).filter(f => f.mode === 'artifact').length,
    data: Object.values(reg.files).filter(f => f.mode === 'data').length,
    events: store.events().length
  };
}
