import { access, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './process.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi']);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

async function executable(candidates) {
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* keep looking */ }
  }
  return candidates.at(-1);
}

export async function ytDlpPath() {
  return executable([join(projectRoot, '.venv', 'bin', 'yt-dlp'), 'yt-dlp']);
}

export function evenlySpaced(items, count) {
  if (items.length <= count) return items;
  if (count === 1) return [items[Math.floor(items.length / 2)]];
  return Array.from({ length: count }, (_, index) => items[Math.round(index * (items.length - 1) / (count - 1))]);
}

export async function catalogSource(source, requestedCount = 15) {
  const count = Math.max(10, Math.min(20, Number(requestedCount) || 15));
  if (/^https?:\/\//i.test(source)) {
    const executablePath = await ytDlpPath();
    const { stdout } = await runProcess(executablePath, ['--flat-playlist', '--dump-single-json', '--no-warnings', source]);
    const parsed = JSON.parse(stdout);
    const entries = parsed.entries?.filter(Boolean) || [parsed];
    const selected = evenlySpaced(entries, count).map((entry, index) => ({
      id: String(entry.id || index + 1),
      title: entry.title || `Video ${index + 1}`,
      url: entry.url?.startsWith('http') ? entry.url : `https://www.youtube.com/watch?v=${entry.id}`,
      channel: entry.channel || parsed.channel || parsed.uploader || '',
      sourceIndex: entries.indexOf(entry),
    }));
    return { kind: entries.length > 1 ? 'channel-or-playlist' : 'video', source, available: entries.length, requested: count, selected };
  }

  const absolute = resolve(source);
  const info = await stat(absolute);
  if (info.isFile()) {
    if (!VIDEO_EXTENSIONS.has(extname(absolute).toLowerCase())) throw new Error(`Unsupported video file: ${absolute}`);
    return { kind: 'local-file', source: absolute, available: 1, requested: 1, selected: [{ id: 'local-1', title: absolute.split('/').at(-1), path: absolute, sourceIndex: 0 }] };
  }
  const entries = (await readdir(absolute, { withFileTypes: true }))
    .filter(entry => entry.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry, index) => ({ id: `local-${index + 1}`, title: entry.name, path: join(absolute, entry.name), sourceIndex: index }));
  if (!entries.length) throw new Error(`No supported videos found in ${absolute}`);
  return { kind: 'local-folder', source: absolute, available: entries.length, requested: count, selected: evenlySpaced(entries, count) };
}
