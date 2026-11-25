// 本地工作台服务：静态前端 + 能力调用 + 项目只读文件访问。仅绑定回环地址。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {ROOT} from '../root.mjs';
import {initPlugins, listCapabilities, listPlanned, pluginSummary, runCapability, projectOverview, STAGES, resolveInside} from '../capabilities/index.mjs';
import {pluginsEnabled} from '../contracts/plugins.mjs';
import {openStore} from '../store/index.mjs';
import {queryIndex, statIndexFor} from '../indexer/build.mjs';
import {queryProblems} from '../contracts/index-query.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUDIO = path.join(ROOT, 'src/studio');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.fbx': 'application/octet-stream', '.obj': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8'
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {'content-type': type, 'cache-control': 'no-store'});
  res.end(body);
}

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 2 * 1024 * 1024) throw new Error('请求体过大');
  }
  return body ? JSON.parse(body) : {};
}

export async function startStudio({project, port = 0, host = '127.0.0.1'} = {}) {
  const bundled = await build({
    entryPoints: [path.join(STUDIO, 'app/main.jsx')],
    bundle: true, write: false, format: 'esm', target: ['es2022'],
    jsxFactory: 'h', jsxFragment: 'Fragment', loader: {'.jsx': 'jsx'},
    define: {'process.env.NODE_ENV': '"production"'}, logLevel: 'silent'
  });
  const appJs = bundled.outputFiles[0].text;
  const shell = fs.readFileSync(path.join(STUDIO, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(STUDIO, 'styles.css'), 'utf8');
  const defaultProject = project ? path.resolve(project) : '';

  await initPlugins({
    projectDir: defaultProject ? path.dirname(defaultProject) : undefined,
    enabled: pluginsEnabled(process.env.SPACE_PLUGINS)
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || host}`);
      const p = url.pathname;

      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        const html = shell.replace('<!--BOOT-->', `<script>window.__STUDIO_PROJECT__=${JSON.stringify(defaultProject)}</script>`);
        return send(res, 200, html, MIME['.html']);
      }
      if (req.method === 'GET' && p === '/app.js') return send(res, 200, appJs, MIME['.js']);
      if (req.method === 'GET' && p === '/styles.css') return send(res, 200, css, MIME['.css']);

      if (req.method === 'GET' && p === '/api/capabilities') {
        return send(res, 200, JSON.stringify({stages: STAGES, capabilities: listCapabilities(), planned: listPlanned(), plugins: pluginSummary()}));
      }

      if (req.method === 'GET' && p === '/api/project') {
        const file = url.searchParams.get('path');
        if (!file) return send(res, 400, JSON.stringify({error: '缺少 path'}));
        return send(res, 200, JSON.stringify(projectOverview(file)));
      }

      if (req.method === 'GET' && p === '/api/file') {
        const projectDir = url.searchParams.get('project');
        const rel = url.searchParams.get('path');
        if (!projectDir || !rel) return send(res, 400, JSON.stringify({error: '缺少 project 或 path'}));
        const abs = resolveInside(path.dirname(path.resolve(projectDir)), rel);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, JSON.stringify({error: '文件不存在'}));
        const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, {'content-type': type, 'cache-control': 'no-store'});
        return fs.createReadStream(abs).pipe(res);
      }

      // 索引摘要：大图纸的首屏只拿这个，不再传完整 JSON。
      if (req.method === 'GET' && p === '/api/index') {
        const file = url.searchParams.get('project');
        if (!file) return send(res, 400, JSON.stringify({error: '缺少 project'}));
        const store = openStore(path.resolve(file));
        return send(res, 200, JSON.stringify(await statIndexFor(store)));
      }

      // 视口取数：按包围盒分页返回图元，工作台滚动加载。
      if (req.method === 'GET' && p === '/api/entities') {
        const file = url.searchParams.get('project');
        if (!file) return send(res, 400, JSON.stringify({error: '缺少 project'}));
        const rawBox = url.searchParams.get('box');
        const box = rawBox ? rawBox.split(',').map(v => Number(v.trim())) : undefined;
        const query = {
          dataset: url.searchParams.get('dataset') || undefined,
          box,
          layers: url.searchParams.get('layer') || undefined,
          types: url.searchParams.get('type') || undefined,
          limit: url.searchParams.get('limit') || undefined,
          offset: url.searchParams.get('offset') || undefined,
          count: ['1', 'true'].includes(url.searchParams.get('count') || '')
        };
        const problems = queryProblems(query);
        if (problems.length) return send(res, 400, JSON.stringify({error: problems.join('；'), problems}));
        const store = openStore(path.resolve(file));
        return send(res, 200, JSON.stringify(await queryIndex(store, query)));
      }

      if (req.method === 'POST' && p === '/api/run') {
        const body = await readJsonBody(req);
        if (!body.project || !body.capability) return send(res, 400, JSON.stringify({error: '缺少 project 或 capability'}));
        try {
          const result = await runCapability({project: body.project, capability: body.capability, params: body.params || {}});
          return send(res, 200, JSON.stringify({ok: true, ...result}));
        } catch (e) {
          return send(res, 200, JSON.stringify({ok: false, error: e.message, logs: e.logs || []}));
        }
      }

      return send(res, 404, JSON.stringify({error: 'not found'}));
    } catch (e) {
      return send(res, 500, JSON.stringify({error: e.message}));
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const actualPort = server.address().port;
  return {
    url: `http://${host}:${actualPort}/`,
    port: actualPort,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
