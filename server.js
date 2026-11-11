import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { runCommand } from './src/commands.js';
import { studyStatus } from './src/study.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 8788);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.aikiscene': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8' };

// Only the app itself and finished study artefacts are served; never the repo, sources or downloaded videos.
const PUBLIC = [/^index\.html$/, /^viewer\.html$/, /^vendor\/three\/(build\/three\.(module|core)\.js|examples\/jsm\/(loaders\/SVGLoader|controls\/OrbitControls)\.js)$/, /^styles\.css$/, /^src\/[a-z0-9-]+\.js$/, /^examples\/[a-z0-9.-]+\.svg$/,
  /^workspaces\/[a-z0-9-]+\/(motion-style-blueprint\.json|summary\.md|pack\/(pack\.json|style-guide\.md)|evidence\/[a-z0-9_-]+\.jpg|reconstruction\/(visual-reconstruction-blueprint\.json|scene\.aikiscene|(reconstruction|character)\.svg|reconstruction\.png|reference\.png|scene\.js))$/];

// The API is for this page only: same-origin, JSON, and a Host we expect (blocks other websites and DNS rebinding).
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const apiAllowed = request => allowedHosts.has(request.headers.host)
  && (!request.headers.origin || allowedHosts.has(new URL(request.headers.origin).host))
  && (request.method !== 'POST' || /^application\/json\b/i.test(request.headers['content-type'] || ''));

const json = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
async function readBody(request, limit = 20_000) {
  let body = '';
  for await (const chunk of request) { body += chunk; if (body.length > limit) throw Object.assign(new Error('Request too large'), { status: 413 }); }
  return body ? JSON.parse(body) : {};
}
const studyUrls = (id, status) => status.state === 'done' ? {
  workspaceUrl: `/workspaces/${id}/`,
  evidenceUrl: status.result?.evidenceFrame ? `/workspaces/${id}/${status.result.evidenceFrame.image}` : null,
  reconstructionUrl: status.result?.reconstruction?.available ? `/workspaces/${id}/reconstruction/reconstruction.svg` : null,
  reconstructionBlueprintUrl: status.result?.reconstruction?.available ? `/workspaces/${id}/reconstruction/visual-reconstruction-blueprint.json` : null,
  aikiSceneUrl: status.result?.reconstruction?.available ? `/workspaces/${id}/reconstruction/scene.aikiscene` : null,
} : {};

async function api(request, response, url) {
  if (!apiAllowed(request)) return json(response, 403, { error: 'Forbidden' });
  if (request.method === 'POST' && url.pathname === '/api/analyze') {
    const input = await readBody(request);
    const source = String(input.source || '').trim();
    if (!source) return json(response, 400, { error: 'Add a YouTube channel, shorts URL, video, or local folder.' });
    const studyId = `study-${randomBytes(4).toString('hex')}`;
    const started = await runCommand('style_analyze_channel', { source, videoCount: input.videoCount, reconstructionQuality: input.reconstructionQuality, name: input.name, background: true, outputDir: join(root, 'workspaces', studyId) });
    return json(response, 202, { studyId, ...started });
  }
  const match = url.pathname.match(/^\/api\/analyze\/([a-z0-9-]+)$/);
  if (request.method === 'GET' && match) {
    const status = await studyStatus(join(root, 'workspaces', match[1]));
    return json(response, 200, { ...status, ...studyUrls(match[1], status) });
  }
  return json(response, 404, { error: 'Not found' });
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await api(request, response, url);
    let relative = normalize(decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(1))).split(sep).join('/');
    if (!PUBLIC.some(pattern => pattern.test(relative))) throw new Error('Not found');
    if (relative.startsWith('vendor/three/')) relative = `node_modules/three/${relative.slice('vendor/three/'.length)}`;
    if (!(await stat(join(root, relative))).isFile()) throw new Error('Not found');
    response.writeHead(200, { 'content-type': types[extname(relative)] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(await readFile(join(root, relative)));
  } catch (error) {
    if (request.url?.startsWith('/api/')) return json(response, error.status || 500, { error: error.message });
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Poly Style Lab: http://127.0.0.1:${port}`));
