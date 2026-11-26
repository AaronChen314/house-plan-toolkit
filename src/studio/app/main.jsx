import {h, Fragment, render} from 'preact';
import {useState, useEffect, useRef, useMemo} from 'preact/hooks';
import {createModelStage} from '../views/model3d.js';
import {palette, classifyEntity, categoryForEntityType, categoryColor, CAD_CATEGORIES as CATEGORIES} from '../../contracts/cad-colors.mjs';

const fileUrl = (project, rel) => `/api/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(rel)}`;

async function getJson(url, options) {
  const r = await fetch(url, options);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function defaultsFor(cap) {
  const out = {};
  for (const p of cap.params || []) out[p.key] = p.default ?? (p.type === 'boolean' ? false : '');
  return out;
}

// 按契约的 type 转换：number 参数在界面上是文本框，发出去必须是数字。
function coerceParams(cap, params) {
  const out = {...params};
  for (const p of cap.params || []) {
    const value = out[p.key];
    if (p.type === 'number') {
      if (value === '' || value === undefined || value === null) delete out[p.key];
      else out[p.key] = Number(value);
    } else if (p.type === 'boolean') {
      out[p.key] = value === true;
    } else if (p.type === 'text' && value === '') {
      delete out[p.key];
    }
  }
  return out;
}

function App() {
  const [projectPath, setProjectPath] = useState(window.__STUDIO_PROJECT__ || '');
  const [project, setProject] = useState(null);
  const [caps, setCaps] = useState([]);
  const [planned, setPlanned] = useState([]);
  const [stages, setStages] = useState([]);
  const [active, setActive] = useState('cad.inspect');
  const [paramsByCap, setParamsByCap] = useState({});
  const [logs, setLogs] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showIndex, setShowIndex] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showTrace, setShowTrace] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    getJson('/api/capabilities')
      .then(d => { setCaps(d.capabilities); setPlanned(d.planned || []); setStages(d.stages); })
      .catch(e => setError(e.message));
  }, []);
  useEffect(() => { if (!projectPath) return; openProject(projectPath); }, []);

  const cap = caps.find(c => c.id === active);
  const plannedCap = planned.find(p => p.id === active);
  const params = paramsByCap[active] || (cap ? defaultsFor(cap) : {});
  const setParams = (next) => setParamsByCap(prev => ({...prev, [active]: next}));

  async function openProject(path) {
    setError('');
    try {
      const d = await getJson(`/api/project?path=${encodeURIComponent(path)}`);
      setProject(d);
      setProjectPath(d.file);
      setResult(null);
      setLogs([]);
    } catch (e) { setError(e.message); setProject(null); }
  }

  async function runCapability() {
    if (!project) { setError('先打开一个项目'); return; }
    if (plannedCap) { setError(`${active} 还没有实现：${plannedCap.blockedBy}`); return; }
    setBusy(true); setError(''); setLogs([]); setResult(null);
    try {
      const d = await getJson('/api/run', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({project: projectPath, capability: active, params: coerceParams(cap, params)})
      });
      setLogs(d.logs || []);
      if (!d.ok) setError(d.error || '执行失败');
      else setResult(d);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const accepted = (p) => {
    if (p.type === 'output') return project?.files.filter(f => f.startsWith('output/')).filter(f => !p.accept || p.accept.split(',').some(ext => f.toLowerCase().endsWith(ext.trim())));
    if (!p.accept) return project?.files || [];
    return (project?.files || []).filter(f => p.accept.split(',').some(ext => f.toLowerCase().endsWith(ext.trim())));
  };

  return (
    <div class="app">
      <header>
        <h1>户型工作台</h1>
        <input type="text" value={projectPath} onInput={e => setProjectPath(e.target.value)} placeholder="项目配置文件路径，例如 my-house/project.json" />
        <button class="primary" onClick={() => openProject(projectPath)}>打开项目</button>
        {project && <button data-testid="preview-toggle" onClick={() => setShowPreview(v => !v)} class={showPreview ? 'active' : ''}>{showPreview ? '收起预览' : '数据预览'}</button>}
        {project && <button data-testid="source-toggle" onClick={() => { setShowSource(v => !v); setShowPreview(false); }} class={showSource ? 'active' : ''}>{showSource ? '收起核对' : '构件核对'}</button>}
        {project && <button data-testid="index-toggle" onClick={() => { setShowIndex(v => !v); setShowPreview(false); }} class={showIndex ? 'active' : ''}>{showIndex ? '收起索引' : '几何索引'}</button>}
        {project && <button data-testid="confirm-toggle" onClick={() => { setShowConfirm(v => !v); setShowPreview(false); }} class={showConfirm ? 'active' : ''}>{showConfirm ? '收起确认' : '确认清单'}</button>}
        {project && <button data-testid="trace-toggle" onClick={() => { setShowTrace(v => !v); setShowPreview(false); }} class={showTrace ? 'active' : ''}>{showTrace ? '收起描图' : '底图描图'}</button>}
        {project && <span class="meta">{project.project.id} · v{project.project.schema} · {project.files.length} 个文件</span>}
      </header>
      <div class="body">
        <nav>
          {stages.map(s => (
            <Fragment key={s.id}>
              <h2>{s.name}</h2>
              {caps.filter(c => c.stage === s.id).map(c => (
                <button key={c.id} class={c.id === active ? 'active' : ''} title={c.plugin ? `插件：${c.plugin.name}@${c.plugin.version}` : c.id} onClick={() => setActive(c.id)}>{c.title}{c.plugin ? ' ⊕' : ''}</button>
              ))}
              {planned.filter(c => c.stage === s.id).map(c => (
                <button key={c.id} data-testid={`planned-${c.id}`} class={`planned ${c.id === active ? 'active' : ''}`} onClick={() => setActive(c.id)} title={`未实现：${c.blockedBy}`}>{c.title} ·</button>
              ))}
            </Fragment>
          ))}
        </nav>
        <main>
          <div class="work">
            {error && <div class="banner err">{error}</div>}
            {project?.lint && !project.lint.passed && (
              <div class="banner warn">
                目录规范：{project.lint.summary.errors} error / {project.lint.summary.warnings} warning
                {project.lint.errors.slice(0, 2).map(e => <div key={e.code + e.path}>{e.code} {e.path}：{e.message}</div>)}
              </div>
            )}
            {project && showIndex && <IndexPanel projectPath={projectPath} />}
            {project && showConfirm && <ConfirmPanel projectPath={projectPath} files={project.files || []} />}
            {project && showSource && <SourcePanel projectPath={projectPath} files={project.files || []} />}
            {project && showPreview && <TracePanel projectPath={projectPath} files={project.files || []} preview onEdit={() => { setShowPreview(false); setShowTrace(true); }} />}
            {project && showTrace && <TracePanel projectPath={projectPath} files={project.files || []} />}
            {!project && <div class="panel"><h3>打开一个项目</h3><p class="desc">填写 project.json 的路径（相对当前工作目录或绝对路径）。工作台只读取项目文件，生成物写入项目 output/。</p></div>}
            {plannedCap && (
              <div class="panel" data-testid="planned-panel">
                <h3>{plannedCap.title} <span class="meta">· {plannedCap.id}</span></h3>
                <p class="desc">{plannedCap.description}</p>
                <div class="banner warn">未实现：{plannedCap.blockedBy}</div>
                <p class="desc">契约已经登记（见 <code>space cap show {plannedCap.id}</code>），实现之后这里会自动出现表单，不需要改界面。</p>
              </div>
            )}
            {!plannedCap && project && cap && (
              <div class="panel">
                <h3>{cap.title}</h3>
                <p class="desc">{cap.description}</p>
                <div class="form">
                  {(cap.params || []).map(p => (
                    <label key={p.key}>
                      {p.label}
                      {p.type === 'boolean' ? (
                        <input type="checkbox" checked={params[p.key] === true} onChange={e => setParams({...params, [p.key]: e.target.checked})} />
                      ) : p.type === 'select' ? (
                        <select value={params[p.key] ?? ''} onChange={e => setParams({...params, [p.key]: e.target.value})}>
                          {(p.options || []).map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : p.type === 'path' || p.type === 'output' ? (
                        <select value={params[p.key] ?? ''} onChange={e => setParams({...params, [p.key]: e.target.value})}>
                          <option value="">选择文件…</option>
                          {accepted(p).map(f => <option key={f} value={f}>{f}</option>)}
                        </select>
                      ) : (
                        <input type="text" value={params[p.key] ?? ''} onInput={e => setParams({...params, [p.key]: e.target.value})} />
                      )}
                    </label>
                  ))}
                  <button class="primary" disabled={busy} onClick={runCapability}>{busy ? '执行中…' : '执行'}</button>
                </div>
              </div>
            )}
            {!plannedCap && result && <Result result={result} active={active} projectPath={projectPath} />}
            {!plannedCap && !result && project && <div class="panel"><span class="meta">选择能力后执行。CAD 索引与模型转换会写 output/；校验与预览不写文件。</span></div>}
          </div>
          <div class="log">{logs.length ? logs.join('\n') : <span class="empty">日志输出…</span>}</div>
        </main>
      </div>
    </div>
  );
}

// 底图描图：把 PDF/截图渲染出的底图放进同一套毫米坐标里，两点画一面墙，
// 保存后由 annotation.trace 合并进数据集模型（带操作者与时间）。
function TracePanel({projectPath, files, preview = false, onEdit}) {
  const datasets = (files || []).map(f => /^data\/datasets\/([^/]+)\/dataset\.json$/.exec(f)).filter(Boolean).map(m => m[1]);
  // 底图优先取 CAD 出的图纸，别把三维效果图当底图。
  const images = (files || []).filter(f => /\.(png|jpe?g|webp)$/i.test(f))
    .sort((a, b) => rankUnderlay(a) - rankUnderlay(b));
  const [dataset, setDataset] = useState(datasets[0] || '');
  const [image, setImage] = useState(images[0] || '');
  const [mmPerPx, setMmPerPx] = useState('12.5');
  const [origin, setOrigin] = useState('0,0');
  const [thickness, setThickness] = useState('200');
  const [actor, setActor] = useState('');
  const [size, setSize] = useState(null);
  const [items, setItems] = useState([]);
  const [pending, setPending] = useState(null);
  const [walls, setWalls] = useState([]);
  const [mode, setMode] = useState('draw');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { if (!dataset && datasets.length) setDataset(datasets[0]); }, [datasets.join(',')]);
  useEffect(() => { if (!image && images.length) setImage(images[0]); }, [images.join(',')]);
  useEffect(() => {
    if (!dataset) { setWalls([]); return; }
    const modelPath = `data/datasets/${dataset}/model.json`;
    if (!(files || []).includes(modelPath)) { setWalls([]); return; }
    let dead = false;
    fetch(fileUrl(projectPath, modelPath))
      .then(r => (r.ok ? r.json() : null))
      .then(m => {
        if (dead) return;
        const floors = m?.floors || [];
        const walls = floors.flatMap(f => (f.walls || []).map(w => ({...w, kind: 'wall', floor: f.id})));
        // 门窗也是识别出来的结构化实体：一样画出来，才能核对与判无效。
        const doors = floors.flatMap(f => (f.doors || []).map(d => ({
          handle: d.handle || `${f.id}:${d.id}`,
          kind: 'door',
          rect: d.footprint?.[0]?.outer || [d.hinge, d.closedEnd, d.openEnd].filter(Boolean),
          provenance: d.provenance, confidence: d.confidence, floor: f.id
        })));
        const windows = floors.flatMap(f => (f.windowOpenings || []).flatMap(w => (w.footprint || []).map(p => ({
          handle: w.handle || `${f.id}:${w.id}`, kind: 'window', rect: p.outer, provenance: w.provenance, confidence: w.confidence, floor: f.id
        }))));
        setWalls([...walls, ...doors, ...windows].filter(x => {
          const ring = x.rect || x.polygon?.outer;
          return Array.isArray(ring) && ring.length >= 3;
        }));
      })
      .catch(() => { if (!dead) setWalls([]); });
    return () => { dead = true; };
  }, [dataset, projectPath]);

  // 选中的底图如果来自 cad.vector，就用它算好的比例与原点预填，避免手动对齐。
  useEffect(() => {
    if (!image) return;
    if (!(files || []).includes('output/cad/underlay.json')) return;
    let dead = false;
    // 只读底图元数据（几百字节），不拉整包 cad-source。
    fetch(fileUrl(projectPath, 'output/cad/underlay.json'))
      .then(r => (r.ok ? r.json() : null))
      .then(meta => {
        if (dead || !meta || meta.file !== image) return;
        if (Number.isFinite(meta.mmPerPx)) setMmPerPx(String(meta.mmPerPx));
        if (Array.isArray(meta.origin)) setOrigin(meta.origin.join(','));
      })
      .catch(() => {});
    return () => { dead = true; };
  }, [image, projectPath]);

  useEffect(() => {
    if (!image) { setSize(null); return; }
    const img = new window.Image();
    img.onload = () => setSize({w: img.naturalWidth, h: img.naturalHeight});
    img.onerror = () => setSize(null);
    img.src = fileUrl(projectPath, image);
  }, [image, projectPath]);

  const k = Number(mmPerPx);
  const [ox, oy] = origin.split(',').map(v => Number(v.trim()));
  const vb = {
    x: Number.isFinite(ox) ? ox : 0,
    y: Number.isFinite(oy) ? oy : 0,
    w: size && k > 0 ? size.w * k : 4000,
    h: size && k > 0 ? size.h * k : 3000
  };

  const invalidSet = new Set(items.filter(i => i.kind === 'invalid').map(i => i.handle));

  function markInvalid(wall, e) {
    if (mode !== 'invalid') return;
    e.stopPropagation();
    setItems(prev => prev.some(i => i.kind === 'invalid' && i.handle === wall.handle)
      ? prev.filter(i => !(i.kind === 'invalid' && i.handle === wall.handle))
      : [...prev, {kind: 'invalid', handle: wall.handle, reason: 'studio 判为无效'}]);
  }

  function click(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const x = +(vb.x + (e.clientX - r.left) / r.width * vb.w).toFixed(1);
    const y = +(vb.y + (e.clientY - r.top) / r.height * vb.h).toFixed(1);
    if (!pending) { setPending([x, y]); return; }
    setItems(prev => [...prev, {kind: 'wall', from: pending, to: [x, y], thicknessMm: Number(thickness) || 200}]);
    setPending(null);
  }

  async function save() {
    if (!dataset) { setError('先在项目里建立数据集'); return; }
    if (!items.length) { setError('先画至少一面墙：点两下'); return; }
    if (!actor.trim()) { setError('填写操作者；人工改动要能追溯'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const r = await fetch('/api/run', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          project: projectPath,
          capability: 'annotation.trace',
          params: {
            dataset, items, actor: actor.trim(),
            underlay: {file: image, mmPerPx: k, origin: [vb.x, vb.y]}
          }
        })
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || '保存失败');
      setMessage(d.summary || '已合并');
      setItems([]); setPending(null);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div class="panel" data-testid="trace-panel">
      <h3>底图描图</h3>
      <div class="toolbar">
        <label class="meta">数据集
          <select value={dataset} onChange={e => setDataset(e.target.value)}>
            {datasets.length ? datasets.map(id => <option key={id} value={id}>{id}</option>) : <option value="">（无）</option>}
          </select>
        </label>
        <label class="meta">底图
          <select value={image} onChange={e => setImage(e.target.value)}>
            {images.length ? images.map(f => <option key={f} value={f}>{f}</option>) : <option value="">（没有图片）</option>}
          </select>
        </label>
        {!preview && (
          <>
            <label class="meta">mm/像素
              <input type="text" size="6" value={mmPerPx} onInput={e => setMmPerPx(e.target.value)} />
            </label>
            <label class="meta">原点 x,y
              <input type="text" size="10" value={origin} onInput={e => setOrigin(e.target.value)} />
            </label>
            <label class="meta">墙厚 mm
              <input type="text" size="5" value={thickness} onInput={e => setThickness(e.target.value)} />
            </label>
            <label class="meta">操作者
              <input type="text" size="8" value={actor} onInput={e => setActor(e.target.value)} placeholder="你的名字" />
            </label>
            <label class="meta">模式
              <select value={mode} onChange={e => setMode(e.target.value)}>
                <option value="draw">画墙</option>
                <option value="invalid">判为无效</option>
              </select>
            </label>
            <button class="primary" disabled={busy} onClick={save}>{busy ? '保存中…' : `保存 ${items.length} 项`}</button>
          </>
        )}
        {preview && onEdit && <button class="primary" onClick={onEdit}>去描图修正</button>}
      </div>
      <div class="toolbar">
        <span class="meta">已有实体 {walls.length} 个 ·</span>
        {['wall', 'door', 'window', 'axis', 'dimension', 'furniture'].map(key => (
          <span key={key} class="meta" style={{color: palette()[key]}}>{key}</span>
        ))}
        <span class="meta">实线=manual · 虚线=ai · 点线=其他来源 · 红点=低置信度</span>
        {!preview && <span class="meta">切到「判为无效」后点实体即可标记</span>}
      </div>
      {!image && <div class="banner warn" data-testid="trace-empty">没有可用底图：先运行 <code>space cap run cad.raster</code>（PDF / 图片 / DXF）生成底图。</div>}
      {preview && <div class="meta">只读预览：墙/门/窗按 CAD 类别上色，虚线=AI，点线=历史来源，红点=置信度低于 0.8。要修改点「去描图修正」。</div>}
      {message && <div class="banner ok">{message}</div>}
      {error && <div class="banner err">{error}</div>}
      <div class="stage">
        {image && (
          <svg data-testid="trace-canvas" viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} onClick={preview ? undefined : click} style={preview ? undefined : 'cursor:crosshair'}>
            <image href={fileUrl(projectPath, image)} x={vb.x} y={vb.y} width={vb.w} height={vb.h} opacity="0.85" />
            {walls.map((w, i) => {
              const outer = w.rect || w.polygon?.outer || [];
              if (outer.length < 3) return null;
              const invalid = invalidSet.has(w.handle);
              const low = Number.isFinite(w.confidence) && w.confidence < 0.8;
              // 颜色只表示 CAD 类别（与惯例同表）；来源用线型区分，不抢颜色。
              const color = invalid ? '#b3261e' : (palette()[w.category] || palette()[w.kind] || palette().wall);
              const provenanceDash = invalid ? undefined : w.provenance === 'ai' ? `${vb.w / 200} ${vb.w / 300}` : w.provenance === 'cadvec' ? `${vb.w / 400} ${vb.w / 400}` : undefined;
              const points = outer.map(([x, y]) => `${x},${y}`).join(' ');
              return (
                <polygon key={w.handle || i} points={points} fill={invalid ? 'rgba(179,38,30,0.25)' : color}
                  fillOpacity={invalid ? 0.25 : 0.18} stroke={color} strokeWidth={Math.max(vb.w / 900, 6) * (w.provenance === 'manual' ? 1.6 : 1)}
                  strokeDasharray={provenanceDash}
                  style={mode === 'invalid' ? 'cursor:pointer' : undefined}
                  onClick={e => markInvalid(w, e)}>
                  {low && <circle cx={outer[0][0]} cy={outer[0][1]} r={Math.max(vb.w / 220, 30)} fill="#dc2626" opacity="0.85" />}
                  <title>{`${w.handle} · ${w.kind || 'wall'} · ${w.provenance || '未标记'}${Number.isFinite(w.confidence) ? ` · 置信度 ${w.confidence}` : ''}${invalid ? ' · 已判无效' : ''}`}</title>
                </polygon>
              );
            })}
            {items.map((w, i) => (
              <line key={i} x1={w.from[0]} y1={w.from[1]} x2={w.to[0]} y2={w.to[1]}
                stroke="#b3261e" stroke-width={w.thicknessMm} stroke-linecap="square" opacity="0.9" />
            ))}
            {pending && <circle cx={pending[0]} cy={pending[1]} r={Math.max(vb.w / 200, 20)} fill="#1a5fb4" />}
          </svg>
        )}
      </div>
      {!preview && <p class="desc">点两下画一面墙；比例或原点不准时改上面的数字，网格会跟着变。保存后墙会带 <code>provenance: manual</code> 与操作者写进数据集模型。</p>}
    </div>
  );
}

// 确认清单：一次只确认一项，必须写依据；判为无效也走同一条路径。
// 数据来自 data/datasets/<id>/dataset.json（权威文件），写入走 annotation.confirm 能力。
function ConfirmPanel({projectPath, files}) {
  const datasets = (files || [])
    .map(rel => /^data\/datasets\/([^/]+)\/dataset\.json$/.exec(rel))
    .filter(Boolean).map(m => m[1]).sort();
  const [dataset, setDataset] = useState(datasets[0] || '');
  const [record, setRecord] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [drafts, setDrafts] = useState({});

  useEffect(() => { if (!dataset && datasets.length) setDataset(datasets[0]); }, [datasets.join(',')]);
  useEffect(() => { if (dataset) load(); }, [dataset, projectPath]);

  async function load() {
    setError(''); setRecord(null);
    try {
      const r = await fetch(fileUrl(projectPath, `data/datasets/${dataset}/dataset.json`));
      if (!r.ok) throw new Error(`读取失败（HTTP ${r.status}）`);
      setRecord(await r.json());
    } catch (e) { setError(e.message); }
  }

  async function confirm(object, field, {invalid = false} = {}) {
    const draft = drafts[`${object}::${field}`] || {};
    if (!draft.value && !invalid) { setError('请先填确认值'); return; }
    if (!draft.basis?.trim()) { setError('确认必须写依据（图纸位置、说明或测量）'); return; }
    setBusy(`${object}::${field}`); setError('');
    try {
      const r = await fetch('/api/run', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          project: projectPath,
          capability: 'annotation.confirm',
          params: {dataset, object, field, ...(invalid ? {invalid: true} : {value: draft.value}), basis: draft.basis.trim()}
        })
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || '确认失败');
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }

  if (!datasets.length) {
    return (
      <div class="panel" data-testid="confirm-panel">
        <h3>确认清单</h3>
        <div class="banner warn" data-testid="confirm-empty">还没有数据集：先运行 <code>space dataset build</code>。</div>
      </div>
    );
  }

  const confirmed = new Map((record?.confirmations || []).map(c => [`${c.object}::${c.field}`, c]));
  const pending = (record?.assumptions || []).filter(a => !confirmed.has(`${a.object}::${a.field}`));
  const setDraft = (key, patch) => setDrafts(prev => ({...prev, [key]: {...(prev[key] || {}), ...patch}}));

  return (
    <div class="panel" data-testid="confirm-panel">
      <h3>确认清单</h3>
      <div class="toolbar">
        <label class="meta">数据集
          <select value={dataset} onChange={e => setDataset(e.target.value)}>
            {datasets.map(id => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        {record && <span class="meta" data-testid="confirm-status">状态 {record.status} · 已确认 {(record.confirmations || []).length} 条 · 待确认 {pending.length} 条</span>}
      </div>
      {error && <div class="banner err">{error}</div>}
      {!record && <span class="meta">读取中…</span>}

      {!!pending.length && (
        <table>
          <thead><tr><th>对象</th><th>字段</th><th>预览值</th><th>确认值</th><th>依据（必填）</th><th /></tr></thead>
          <tbody>
            {pending.map(a => {
              const key = `${a.object}::${a.field}`;
              const draft = drafts[key] || {};
              return (
                <tr key={key}>
                  <td><code>{a.object}</code></td>
                  <td>{a.field}</td>
                  <td class="meta">{a.value}{a.basis ? `（${a.basis}）` : ''}</td>
                  <td><input type="text" value={draft.value ?? ''} placeholder={String(a.value)} onInput={e => setDraft(key, {value: e.target.value})} /></td>
                  <td><input type="text" value={draft.basis ?? ''} placeholder="图纸位置 / 说明 / 测量" onInput={e => setDraft(key, {basis: e.target.value})} /></td>
                  <td>
                    <button disabled={busy === key} onClick={() => confirm(a.object, a.field)}>确认</button>
                    <button disabled={busy === key} onClick={() => confirm(a.object, a.field, {invalid: true})}>无效</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {!!(record?.confirmations || []).length && (
        <table>
          <thead><tr><th>对象</th><th>字段</th><th>确认值</th><th>依据</th><th>时间</th><th>确认人</th></tr></thead>
          <tbody>
            {record.confirmations.map((c, i) => (
              <tr key={i}>
                <td><code>{c.object}</code></td>
                <td>{c.field}</td>
                <td>{c.invalid ? '（判为无效）' : String(c.value)}</td>
                <td class="meta">{c.basis}</td>
                <td class="meta">{String(c.at).replace('T', ' ').slice(0, 16)}</td>
                <td class="meta">{c.actor || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p class="desc">一次只确认一项，必须写依据；确认记录保留在 <code>dataset.json</code> 里，重建数据集不会丢。</p>
    </div>
  );
}

// 视口取数：先拿索引摘要，再按可见包围盒分页拉图元。
// 索引不存在时给出重建命令，不影响其他能力。
function IndexPanel({projectPath}) {
  const [stat, setStat] = useState(null);
  const [error, setError] = useState('');
  const [view, setView] = useState(null);
  const [rows, setRows] = useState([]);
  const [nextOffset, setNextOffset] = useState(null);
  const [total, setTotal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(0);
  const drag = useRef(null);
  const queryId = useRef(0);

  const boundsView = (b) => {
    const pad = Math.max((b[2] - b[0]) * 0.02, 100);
    return {x: b[0] - pad, y: b[1] - pad, w: b[2] - b[0] + pad * 2, h: b[3] - b[1] + pad * 2};
  };

  useEffect(() => {
    setStat(null); setError(''); setRows([]); setView(null); setTotal(null);
    if (!projectPath) return;
    let dead = false;
    getJson(`/api/index?project=${encodeURIComponent(projectPath)}`)
      .then(d => { if (dead) return; setStat(d); if (d?.present && d.bounds) setView(boundsView(d.bounds)); })
      .catch(e => !dead && setError(e.message));
    return () => { dead = true; };
  }, [projectPath]);

  async function fetchPage(vb, offset, {replace = false, count = false} = {}) {
    if (!vb) return;
    const id = ++queryId.current;
    setBusy(true); setError('');
    try {
      const box = [vb.x, vb.y, vb.x + vb.w, vb.y + vb.h].map(v => v.toFixed(1)).join(',');
      const d = await getJson(`/api/entities?project=${encodeURIComponent(projectPath)}&box=${box}&limit=2000&offset=${offset}${count ? '&count=1' : ''}`);
      if (id !== queryId.current) return; // 视口已经变了，丢弃过期结果
      if (!d.available) { setError(d.reason || '索引不可用'); return; }
      setRows(prev => replace ? d.rows : prev.concat(d.rows));
      setLoaded(prev => replace ? d.rows.length : prev + d.rows.length);
      setNextOffset(d.nextOffset);
      if (count) setTotal(d.total);
      else if (replace) setTotal(null);
    } catch (e) {
      if (id === queryId.current) setError(e.message);
    } finally {
      if (id === queryId.current) setBusy(false);
    }
  }

  useEffect(() => { if (view && stat?.present) fetchPage(view, 0, {replace: true}); }, [view?.x, view?.y, view?.w, view?.h, stat?.present]);

  function zoom(e) {
    e.preventDefault();
    if (!view) return;
    const k = e.deltaY > 0 ? 1.2 : 1 / 1.2;
    const r = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    const mx = view.x + fx * view.w, my = view.y + (1 - fy) * view.h;
    const w = view.w * k, h = view.h * k;
    setView({x: mx - fx * w, y: my - (1 - fy) * h, w, h});
  }
  function down(e) { drag.current = {x: e.clientX, y: e.clientY, vb: view}; e.currentTarget.setPointerCapture(e.pointerId); }
  function move(e) {
    if (!drag.current || !view) return;
    const r = e.currentTarget.getBoundingClientRect();
    const dx = (e.clientX - drag.current.x) / r.width * drag.current.vb.w;
    const dy = (e.clientY - drag.current.y) / r.height * drag.current.vb.h;
    setView({...drag.current.vb, x: drag.current.vb.x - dx, y: drag.current.vb.y - dy});
  }

  if (error && !stat) return <div class="panel"><h3>几何索引</h3><div class="banner err">{error}</div></div>;
  if (!stat) return <div class="panel"><h3>几何索引</h3><span class="meta">读取中…</span></div>;
  if (!stat.available) {
    return (
      <div class="panel" data-testid="index-panel">
        <h3>几何索引</h3>
        <div class="banner warn" data-testid="index-unavailable">{stat.reason || '当前 Node 不支持 node:sqlite'}。升级到 Node 22.5+ 后可用；其余功能不受影响。</div>
      </div>
    );
  }
  if (!stat.present) {
    return (
      <div class="panel" data-testid="index-panel">
        <h3>几何索引</h3>
        <div class="banner warn" data-testid="index-missing">尚未建立索引。运行：<code>space index rebuild --project {'<project.json>'}</code></div>
      </div>
    );
  }
  if (!stat.entities) {
    // 图投影会先建出索引库（里面有节点、没有图元），这里要和「没有索引」分开说。
    return (
      <div class="panel" data-testid="index-panel">
        <h3>几何索引</h3>
        <div class="banner warn" data-testid="index-empty">索引已建立，但还没有图元。运行：<code>space index rebuild --project {'<project.json>'}</code></div>
      </div>
    );
  }

  const vb = view || boundsView(stat.bounds || [0, 0, 1000, 1000]);
  const stroke = Math.max(vb.w / 1200, 1);

  return (
    <div class="panel" data-testid="index-panel">
      <h3>几何索引</h3>
      <div class="toolbar">
        <button onClick={() => stat.bounds && setView(boundsView(stat.bounds))}>全图</button>
        <button onClick={() => fetchPage(vb, 0, {replace: true, count: true})}>统计总数</button>
        <button disabled={busy || nextOffset == null} onClick={() => fetchPage(vb, nextOffset)}>{nextOffset == null ? '本视口已全部加载' : '继续加载一页'}</button>
        <span class="meta" data-testid="index-meta">{stat.entities.toLocaleString()} 个图元 · {stat.layers} 个图层 · {(stat.bytes / 1048576).toFixed(1)} MB · 视口内已加载 {loaded}{total != null ? ` / 共 ${total}` : ''}</span>
      </div>
      <div class="stage">
        <svg data-testid="index-viewport" viewBox={`${vb.x} ${-(vb.y + vb.h)} ${vb.w} ${vb.h}`} onWheel={zoom}
          onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null; }}>
          {rows.map((r, i) => (
            <rect key={`${r.handle || i}-${i}`} x={r.minx} y={-r.maxy} width={Math.max(r.maxx - r.minx, stroke)} height={Math.max(r.maxy - r.miny, stroke)}
              fill="none" stroke="#7d8f86" stroke-width={stroke} />
          ))}
        </svg>
      </div>
      {error && <div class="banner err">{error}</div>}
      <p class="desc">拖动平移、滚轮缩放；每页 2000 条，只在可见范围内取数。索引摘要来自 <code>.space/project.sqlite</code>，删掉可重建。</p>
    </div>
  );
}

function Result({result, active, projectPath}) {
  const [cadData, setCadData] = useState(null);
  const [cadError, setCadError] = useState('');
  const previewFile = result.data?.file;
  const cadFile = active === 'cad.preview' ? result.data?.file
    : active === 'cad.inspect' ? result.outputs?.[0]?.path
    : active === 'model.convert' ? null : null;

  useEffect(() => {
    setCadData(null); setCadError('');
    if (!cadFile) return;
    let dead = false;
    fetch(fileUrl(projectPath, cadFile)).then(r => r.json()).then(d => !dead && setCadData(d)).catch(e => !dead && setCadError(e.message));
    return () => { dead = true; };
  }, [active, cadFile, projectPath]);

  return (
    <div class="panel">
      <h3>结果</h3>
      <p class="desc">{result.summary}</p>
      {!!result.outputs?.length && (
        <div class="outputs">
          {result.outputs.map(o => <div key={o.path}><a href={fileUrl(projectPath, o.path)} target="_blank" rel="noreferrer">{o.path}</a> <span class="meta">({o.kind})</span></div>)}
        </div>
      )}

      {active === 'model.validate' && <Report report={result.data} />}
      {(active === 'cad.inspect' || active === 'cad.preview') && (cadError ? <div class="banner err">{cadError}</div> : cadData ? <CadPreview data={cadData} /> : <span class="meta">加载中…</span>)}
      {active === 'build.viewer' && previewFile && <div class="stage"><iframe src={fileUrl(projectPath, previewFile)} title="生成结果" /></div>}
      {active === 'model.preview' && previewFile && <ModelPanel url={fileUrl(projectPath, previewFile)} />}
      {active === 'model.convert' && previewFile && <ModelPanel url={fileUrl(projectPath, previewFile)} />}
    </div>
  );
}

function Report({report}) {
  if (!report) return null;
  return (
    <div>
      <div class={`banner ${report.passed ? 'ok' : 'err'}`}>{report.passed ? '校验通过' : `${report.issues.length} 个问题`}</div>
      {!!report.issues?.length && (
        <table>
          <thead><tr><th>级别</th><th>对象</th><th>说明</th></tr></thead>
          <tbody>
            {report.issues.map((i, n) => <tr key={n}><td>{i.severity || ''}</td><td><code>{i.object || i.code || ''}</code></td><td>{i.message}</td></tr>)}
          </tbody>
        </table>
      )}
    </div>
  );
}

// 底图排序：宁可没有，也不把效果图当图纸。
function rankUnderlay(f) {
  if (/output\/cad\/underlay\.(png|jpe?g|webp)$/i.test(f)) return 0;
  if (/^output\/cad\//i.test(f)) return 1;
  if (/underlay|底图|plan|平面/i.test(f)) return 2;
  if (/output\/browser-check|render|效果|camera/i.test(f)) return 9;
  return 5;
}

function classifyCadEntity(e) {
  const byType = categoryForEntityType(e.type);
  if (byType) return {category: byType, basis: 'type', confidence: 0.9};
  const hit = classifyEntity({layer: e.effectiveLayer || e.layer, aci: e.resolvedAci ?? e.aci});
  return {category: hit.category || 'other', basis: hit.basis || 'none', confidence: hit.confidence ?? 0};
}

function CadPreview({data, showKinds = false}) {
  const all = useMemo(() => (data.entities || []).map(e => ({...e, ...classifyCadEntity(e)})), [data]);
  const [hidden, setHidden] = useState(() => new Set());
  const linesAll = all.filter(e => e.points?.length > 1);
  const textsAll = all.filter(e => e.text && e.at);
  const lines = linesAll.filter(e => !hidden.has(e.category));
  const texts = textsAll.filter(e => !hidden.has(e.category));
  const counts = useMemo(() => {
    const c = {};
    for (const e of all) c[e.category] = (c[e.category] || 0) + 1;
    return c;
  }, [all]);
  const [info, setInfo] = useState(null);
  const [view, setView] = useState(null);
  const drag = useRef(null);

  const bbox = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const add = ([x, y]) => { minX = Math.min(minX, x); minY = Math.min(minY, -y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, -y); };
    for (const e of lines) for (const pt of e.points) add(pt);
    for (const t of texts) add(t.at);
    if (!Number.isFinite(minX)) return {x: 0, y: 0, w: 1000, h: 1000};
    const pad = Math.max((maxX - minX) * 0.02, 100);
    return {x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2};
  }, [data]);

  const vb = view || bbox;

  function zoom(e) {
    e.preventDefault();
    const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const r = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    setView({x: vb.x + vb.w * fx * (1 - k), y: vb.y + vb.h * fy * (1 - k), w: vb.w * k, h: vb.h * k});
  }
  function down(e) { drag.current = {x: e.clientX, y: e.clientY, vb}; e.currentTarget.setPointerCapture(e.pointerId); }
  function move(e) {
    if (!drag.current) return;
    const r = e.currentTarget.getBoundingClientRect();
    const dx = (e.clientX - drag.current.x) / r.width * drag.current.vb.w;
    const dy = (e.clientY - drag.current.y) / r.height * drag.current.vb.h;
    setView({...drag.current.vb, x: drag.current.vb.x - dx, y: drag.current.vb.y - dy});
  }
  const up = () => { drag.current = null; };
  const stroke = Math.max(vb.w / 900, 1);

  return (
    <div>
      <div class="toolbar">
        <button onClick={() => setView(null)}>全图</button>
        <span class="meta">{lines.length} 条线 · {texts.length} 段文字</span>
        {info && <span class="meta">已选：<code>{info.handle || info.text || ''}</code></span>}
        {showKinds && <button onClick={() => setHidden(new Set())}>全部显示</button>}
        {showKinds && <button onClick={() => setHidden(new Set(Object.keys(counts)))}>全部隐藏</button>}
      </div>
      {showKinds && (
        <div class="toolbar" data-testid="kind-filters">
          {Object.keys(counts).sort((a, b) => counts[b] - counts[a]).map(k => (
            <label class="meta" key={k}>
              <input type="checkbox" checked={!hidden.has(k)}
                onChange={() => setHidden(prev => { const next = new Set(prev); next.has(k) ? next.delete(k) : next.add(k); return next; })} />
              <i style={`display:inline-block;width:.7em;height:.7em;margin-right:.3em;border-radius:2px;background:${categoryColor(k)}`} />
              {CATEGORIES[k]?.label || k} {counts[k]}
            </label>
          ))}
        </div>
      )}
      <div class="stage">
        <svg viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} onWheel={zoom} onPointerDown={down} onPointerMove={move} onPointerUp={up}>
          {lines.map((e, i) => (
            <polyline key={e.id || i} fill="none" stroke={e.color || categoryColor(e.category) || (e.layerColor ? `#${(e.layerColor >>> 0).toString(16).padStart(6, '0')}` : '#7d8f86')}
              stroke-width={stroke} points={e.points.map(([x, y]) => `${x},${-y}`).join(' ')}
              onClick={() => setInfo({handle: e.handle, type: e.type, layer: e.effectiveLayer || e.layer,
                category: e.category, basis: e.basis, confidence: e.confidence})} style="cursor:pointer" />
          ))}
          {texts.map((t, i) => (
            <text key={i} x={t.at[0]} y={-t.at[1]} font-size={t.height || 100} fill="#34483b"
              transform={`rotate(${-t.rotation || 0} ${t.at[0]} ${-t.at[1]})`} onClick={() => setInfo({text: t.text, handle: t.handle, category: t.category})}>{t.text}</text>
          ))}
        </svg>
      </div>
      {info && <pre class="meta">{JSON.stringify(info, null, 2)}</pre>}
    </div>
  );
}

function SourcePanel({projectPath, files}) {
  const candidates = (files || []).filter(f => typeof f === 'string' && /\.json$/.test(f) && /cad|source/i.test(f));
  const [file, setFile] = useState(candidates.find(p => /source\.json$/.test(p)) || candidates[0] || '');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!file) return;
    let dead = false;
    setData(null); setErr('');
    fetch(fileUrl(projectPath, file)).then(r => r.json()).then(j => {
      if (dead) return;
      if (!Array.isArray(j.entities)) throw new Error('不是图元索引（需要 cad-source/v1）');
      setData(j);
    }).catch(e => !dead && setErr(e.message));
    return () => { dead = true; };
  }, [file, projectPath]);

  return (
    <div class="panel" data-testid="source-panel">
      <h2>构件核对</h2>
      <p class="desc">每条线带构件类型：类型来自图层名与图元类型，不猜几何。点线看 handle / 图层 / 依据；勾选框按类型过滤。</p>
      <div class="toolbar">
        <label class="meta">图元索引
          <select value={file} onChange={e => setFile(e.target.value)}>
            {candidates.length ? candidates.map(p => <option key={p} value={p}>{p}</option>) : <option value="">（先跑 cad.inspect）</option>}
          </select>
        </label>
      </div>
      {err && <div class="banner err">{err}</div>}
      {data && <CadPreview data={data} showKinds />}
      {!data && !err && <div class="banner warn">还没有图元索引：<code>space cap run cad.inspect --dxf …</code></div>}
    </div>
  );
}

function ModelPanel({url}) {
  const ref = useRef(null);
  const api = useRef(null);
  const [stats, setStats] = useState(null);
  const [err, setErr] = useState('');
  const [wire, setWire] = useState(false);

  useEffect(() => {
    let dead = false;
    setStats(null); setErr('');
    createModelStage(ref.current, url, {
      onStats: s => !dead && setStats(s),
      onError: m => !dead && setErr(m)
    }).then(a => { if (dead) a.dispose(); else api.current = a; });
    return () => { dead = true; api.current?.dispose(); api.current = null; };
  }, [url]);

  return (
    <div>
      <div class="toolbar">
        <button onClick={() => api.current?.fit()}>居中</button>
        <button onClick={() => { const next = !wire; setWire(next); api.current?.setWireframe(next); }}>{wire ? '显示材质' : '线框'}</button>
        <button onClick={() => api.current?.toggleAnimation()} disabled={!stats?.animations?.length}>播放/暂停动画</button>
      </div>
      <div class="stage" ref={ref} />
      {err && <div class="banner err">模型加载失败：{err}</div>}
      {stats && (
        <div class="stats" style="margin-top:10px">
          <div>三角面<b>{Math.round(stats.triangles).toLocaleString()}</b></div>
          <div>网格 / 材质<b>{stats.meshes} / {stats.materials}</b></div>
          <div>贴图<b>{stats.textures}</b></div>
          <div>尺度 (m)<b>{stats.size ? stats.size.join(' × ') : '—'}</b></div>
          <div>动画<b>{stats.animations.length ? stats.animations.join('、') : '无'}</b></div>
        </div>
      )}
    </div>
  );
}

render(<App />, document.getElementById('app'));
