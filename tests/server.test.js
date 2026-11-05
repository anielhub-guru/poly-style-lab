import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../server.js', import.meta.url));
const port = 20000 + Math.floor(Math.random() * 20000);

const call = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
    let data = ''; res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: data }));
  });
  req.on('error', reject); if (body) req.write(body); req.end();
});

test('server serves the app only, and its API refuses other websites', async t => {
  const child = spawn(process.execPath, [server], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  await new Promise(resolve => child.stdout.once('data', resolve));
  const json = { 'content-type': 'application/json' };

  assert.equal((await call('/')).status, 200);
  assert.equal((await call('/src/app.js')).status, 200);
  for (const path of ['/.git/HEAD', '/package.json', '/server.js', '/workspaces/x/sources/a.mp4', '/%2e%2e/polystudio/AGENTS.md']) assert.equal((await call(path)).status, 404, path);

  const body = JSON.stringify({ source: 'https://www.youtube.com/@x' });
  assert.equal((await call('/api/analyze', { method: 'POST', headers: { 'content-type': 'text/plain' }, body })).status, 403, 'simple cross-site POST');
  assert.equal((await call('/api/analyze', { method: 'POST', headers: { ...json, origin: 'https://evil.example' }, body })).status, 403, 'foreign origin');
  assert.equal((await call('/api/analyze', { method: 'POST', headers: { ...json, host: 'evil.example' }, body })).status, 403, 'DNS rebinding host');
  assert.equal((await call('/api/analyze', { method: 'POST', headers: json, body: JSON.stringify({}) })).status, 400);
  assert.equal((await call('/api/analyze', { method: 'POST', headers: json, body: 'x'.repeat(30_000) })).status, 413);
});
