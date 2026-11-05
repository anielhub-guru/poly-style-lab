import { copyFile, mkdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { runProcess } from './process.js';
import { ytDlpPath } from './source-catalog.js';

const safe = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'video';

export async function ingestCatalog(catalog, workspace, onProgress = () => {}) {
  const sourceDir = join(workspace, 'sources');
  await mkdir(sourceDir, { recursive: true });
  const results = [];
  const ytDlp = await ytDlpPath();
  for (let index = 0; index < catalog.selected.length; index += 1) {
    const item = catalog.selected[index];
    onProgress({ stage: 'download', index: index + 1, total: catalog.selected.length, title: item.title });
    if (item.path) {
      const target = join(sourceDir, `${String(index + 1).padStart(2, '0')}-${safe(item.title)}${extname(item.path)}`);
      await copyFile(item.path, target);
      results.push({ ...item, localPath: target });
      continue;
    }
    const outputTemplate = join(sourceDir, `${String(index + 1).padStart(2, '0')}-${safe(item.title)}.%(ext)s`);
    const { stdout } = await runProcess(ytDlp, [
      '--no-playlist', '--no-warnings', '--print', 'after_move:filepath',
      '-f', 'bv*+ba/b', '--merge-output-format', 'mp4', '-o', outputTemplate, item.url,
    ]);
    results.push({ ...item, localPath: stdout.trim().split('\n').filter(Boolean).at(-1) });
  }
  return results;
}

export async function normalizeVideo(item, workspace, onProgress = () => {}) {
  const normalizedDir = join(workspace, 'normalized-30fps');
  await mkdir(normalizedDir, { recursive: true });
  const output = join(normalizedDir, `${safe(item.id)}.mp4`);
  onProgress({ stage: 'normalize', title: item.title, fps: 30 });
  const probe = await runProcess('ffmpeg', ['-hide_banner', '-i', item.localPath], { onStderr: () => {} }).catch(error => ({ stderr: error.message }));
  const fpsMatch = probe.stderr.match(/(?:,|\s)([0-9.]+) fps/);
  const durationMatch = probe.stderr.match(/Duration:\s*([0-9]+):([0-9]+):([0-9.]+)/);
  const nativeFps = fpsMatch ? Number(fpsMatch[1]) : null;
  const nativeDurationSec = durationMatch ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]) : null;
  await runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', item.localPath, '-vf', 'fps=30', '-r', '30', '-vsync', 'cfr', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', output]);
  return { ...item, normalizedPath: output, nativeFps, nativeDurationSec, analysisFps: 30 };
}
