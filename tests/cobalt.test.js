import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cobaltConfigured, cobaltDownload } from '../src/cobalt.js';
import { singleVideoId } from '../src/source-catalog.js';

async function mockCobalt(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  process.env.COBALT_API_URL = `http://127.0.0.1:${server.address().port}/`;
  t.after(() => { delete process.env.COBALT_API_URL; delete process.env.COBALT_API_KEY; });
  return server.address().port;
}
const body = request => new Promise(resolve => { let data = ''; request.on('data', chunk => { data += chunk; }); request.on('end', () => resolve(data)); });

test('cobalt fallback asks for a small H.264 video-only file, sends the key, and saves the tunnel', async t => {
  let seen;
  const port = await mockCobalt(t, async (request, response) => {
    if (request.method === 'POST') {
      seen = { auth: request.headers.authorization, body: JSON.parse(await body(request)) };
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ status: 'tunnel', url: `http://127.0.0.1:${port}/file` }));
    }
    response.end(Buffer.from('fake-video-bytes'));
  });
  process.env.COBALT_API_KEY = 'secret';
  assert.equal(cobaltConfigured(), true);
  const target = join(await mkdtemp(join(tmpdir(), 'cobalt-')), 'a.mp4');
  await cobaltDownload('https://www.youtube.com/shorts/GmBXKjzM11w', target);
  assert.equal(await readFile(target, 'utf8'), 'fake-video-bytes');
  assert.equal(seen.auth, 'Api-Key secret');
  assert.deepEqual([seen.body.videoQuality, seen.body.downloadMode, seen.body.youtubeVideoCodec], ['480', 'mute', 'h264']);
});

test('cobalt errors are reported readably and oversize files are refused and removed', async t => {
  let mode = 'auth';
  const port = await mockCobalt(t, async (request, response) => {
    if (request.method === 'POST') {
      await body(request); response.setHeader('content-type', 'application/json');
      response.statusCode = mode === 'auth' ? 400 : 200;
      return response.end(JSON.stringify(mode === 'auth' ? { status: 'error', error: { code: 'error.api.auth.jwt.missing' } } : { status: 'tunnel', url: `http://127.0.0.1:${port}/big` }));
    }
    response.end(Buffer.alloc(5000));
  });
  const target = join(await mkdtemp(join(tmpdir(), 'cobalt-')), 'a.mp4');
  await assert.rejects(cobaltDownload('https://youtu.be/GmBXKjzM11w', target), /error\.api\.auth\.jwt\.missing/);
  mode = 'big';
  await assert.rejects(cobaltDownload('https://youtu.be/GmBXKjzM11w', target, { maxBytes: 1000 }), /larger than/);
  await assert.rejects(stat(target), /ENOENT/);
});

test('single-video URLs are recognised without listing; channels are not', () => {
  assert.equal(singleVideoId('https://www.youtube.com/shorts/GmBXKjzM11w'), 'GmBXKjzM11w');
  assert.equal(singleVideoId('https://youtu.be/dQw4w9WgXcQ?t=3'), 'dQw4w9WgXcQ');
  assert.equal(singleVideoId('https://www.youtube.com/@abc'), null);
});
