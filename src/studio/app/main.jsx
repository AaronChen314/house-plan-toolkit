import {h, Fragment, render} from 'preact';
import {useState, useEffect, useRef, useMemo} from 'preact/hooks';
import {createModelStage} from '../views/model3d.js';

const fileUrl = (project, rel) => `/api/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(rel)}`;

async function getJson(url, options) {
  const r = await fetch(url, options);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function defaultsFor(cap) {
  const out = {};
  for (const p of cap.params || []) out[p.key] = p.default ?? '';
  return out;
}

function App() {
  const [projectPath, setProjectPath] = useState(window.__STUDIO_PROJECT__ || '');
  const [project, setProject] = useState(null);
  const [caps, setCaps] = useState([]);
  const [stages, setStages] = useState([]);
  const [active, setActive] = useState('cad.inspect');
  const [paramsByCap, setParamsByCap] = useState({});
  const [logs, setLogs] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { getJson('/api/capabilities').then(d => { setCaps(d.capabilities); setStages(d.stages); }).catch(e => setError(e.message)); }, []);
  useEffect(() => { if (!projectPath) return; openProject(projectPath); }, []);

  const cap = caps.find(c => c.id === active);
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
    setBusy(true); setError(''); setLogs([]); setResult(null);
    try {
      const d = await getJson('/api/run', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({project: projectPath, capability: active, params})
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
        {project && <span class="meta">{project.project.id} · v{project.project.schema} · {project.files.length} 个文件</span>}
      </header>
      <div class="body">
        <nav>
          {stages.map(s => (
            <Fragment key={s.id}>
              <h2>{s.name}</h2>
              {caps.filter(c => c.stage === s.id).map(c => (
                <button key={c.id} class={c.id === active ? 'active' : ''} onClick={() => setActive(c.id)}>{c.title}</button>
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
            {!project && <div class="panel"><h3>打开一个项目</h3><p class="desc">填写 project.json 的路径（相对当前工作目录或绝对路径）。工作台只读取项目文件，生成物写入项目 output/。</p></div>}
            {project && cap && (
              <div class="panel">
                <h3>{cap.title}</h3>
                <p class="desc">{cap.description}</p>
                <div class="form">
                  {(cap.params || []).map(p => (
                    <label key={p.key}>
                      {p.label}
                      {p.type === 'select' ? (
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
            {result && <Result result={result} active={active} projectPath={projectPath} />}
            {!result && project && <div class="panel"><span class="meta">选择能力后执行。CAD 索引与模型转换会写 output/；校验与预览不写文件。</span></div>}
          </div>
          <div class="log">{logs.length ? logs.join('\n') : <span class="empty">日志输出…</span>}</div>
        </main>
      </div>
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

function CadPreview({data}) {
  const entities = data.entities || [];
  const lines = entities.filter(e => e.points?.length > 1);
  const texts = entities.filter(e => e.text && e.at);
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
      </div>
      <div class="stage">
        <svg viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} onWheel={zoom} onPointerDown={down} onPointerMove={move} onPointerUp={up}>
          {lines.map((e, i) => (
            <polyline key={e.id || i} fill="none" stroke={e.layerColor ? `#${(e.layerColor >>> 0).toString(16).padStart(6, '0')}` : '#7d8f86'}
              stroke-width={stroke} points={e.points.map(([x, y]) => `${x},${-y}`).join(' ')}
              onClick={() => setInfo({handle: e.handle, layer: e.layer})} style="cursor:pointer" />
          ))}
          {texts.map((t, i) => (
            <text key={i} x={t.at[0]} y={-t.at[1]} font-size={t.height || 100} fill="#34483b"
              transform={`rotate(${-t.rotation || 0} ${t.at[0]} ${-t.at[1]})`} onClick={() => setInfo({text: t.text, handle: t.handle})}>{t.text}</text>
          ))}
        </svg>
      </div>
      {info && <pre class="meta">{JSON.stringify(info, null, 2)}</pre>}
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
