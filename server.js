import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './src/commands.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 8788);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

createServer(async (request, response) => {
  try {
    if (request.method === 'POST' && request.url === '/api/analyze') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body || '{}');
      const studyId = String(input.studyId || Date.now()).replace(/[^a-z0-9-]/gi, '');
      const outputDir = join(root, 'workspaces', studyId);
      const result = await runCommand('style_analyze_channel', { source: input.source, videoCount: input.videoCount, outputDir });
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ...result, workspaceUrl: `/workspaces/${studyId}/`, evidenceUrl: result.evidenceFrame ? `/workspaces/${studyId}/${result.evidenceFrame.image}` : null }));
      return;
    }
    const pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const path = normalize(join(root, relative));
    if (!path.startsWith(root) || !(await stat(path)).isFile()) throw new Error('Not found');
    response.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(await readFile(path));
  } catch (error) {
    const api = request.url?.startsWith('/api/');
    response.writeHead(api ? 500 : 404, { 'content-type': api ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8' });
    response.end(api ? JSON.stringify({ error: error.message }) : 'Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Poly Style Lab: http://127.0.0.1:${port}`));
