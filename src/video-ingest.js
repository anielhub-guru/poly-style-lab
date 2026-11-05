import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess } from './process.js';
import { ytDlpPath } from './environment.js';
import { cobaltConfigured, cobaltDownload } from './cobalt.js';

export const safeName = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'video';

/** Fetch only what the study needs: the first `maxSeconds`, 480p, no audio. Local files are used in place. */
export async function acquire(item, workspace, maxSeconds) {
  if (item.path) return item.path;
  const dir = join(workspace, 'sources');
  await mkdir(dir, { recursive: true });
  const stem = safeName(item.id);
  const existing = (await readdir(dir)).find(name => name.startsWith(`${stem}.`));
  if (existing) return join(dir, existing);
  try {
    await runProcess(await ytDlpPath(), [
      '--no-playlist', '--no-warnings', '--no-progress', '--retries', '2', '--socket-timeout', '20', '--max-filesize', '60M',
      '-f', 'bv[height<=480][vcodec^=avc1]/bv[height<=480]/b[height<=480]/bv/b',
      '--download-sections', `*0-${maxSeconds}`, '-o', join(dir, `${stem}.%(ext)s`), item.url,
    ], { timeoutMs: 240_000 });
  } catch (error) {
    if (!cobaltConfigured()) throw error;
    try { return await cobaltDownload(item.url, join(dir, `${stem}.mp4`)); }
    catch (fallback) { throw new Error(`${error.message} | ${fallback.message}`); }
  }
  const saved = (await readdir(dir)).find(name => name.startsWith(`${stem}.`) && !name.endsWith('.part'));
  if (!saved) throw new Error('download produced no file');
  return join(dir, saved);
}

/** Constant 30 fps, max 480p tall, first `maxSeconds`, no audio. Returns the normalized path. */
export async function normalize(sourcePath, item, workspace, maxSeconds) {
  const dir = join(workspace, 'normalized-30fps');
  await mkdir(dir, { recursive: true });
  const output = join(dir, `${safeName(item.id)}.mp4`);
  await runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-t', String(maxSeconds), '-i', sourcePath, '-an',
    '-vf', "fps=30,scale=-2:'min(480,ih)':flags=area", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', output], { timeoutMs: 180_000 });
  return output;
}
