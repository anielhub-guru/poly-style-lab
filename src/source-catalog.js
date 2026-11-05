import { readdir, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { runProcess } from './process.js';
import { ytDlpPath } from './environment.js';

export { ytDlpPath };
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi']);
export const LIMITS = { defaultCount: 12, maxCount: 20, recommendedMin: 10, defaultSeconds: 45, maxSeconds: 180, listCap: 120 };

export function evenlySpaced(items, count) {
  if (items.length <= count) return items;
  if (count <= 1) return [items[Math.floor(items.length / 2)]];
  return Array.from({ length: count }, (_, index) => items[Math.round(index * (items.length - 1) / (count - 1))]);
}

/** Pure selection policy: drop duplicates and over-long uploads, then spread the sample across the list. */
export function selectEntries(entries, { count = LIMITS.defaultCount, maxDurationSec = 180 } = {}) {
  const wanted = Math.max(1, Math.min(LIMITS.maxCount, Math.round(Number(count)) || LIMITS.defaultCount));
  const seen = new Set();
  const unique = entries.filter(entry => entry && !seen.has(entry.id ?? entry.url) && seen.add(entry.id ?? entry.url));
  const eligible = unique.filter(entry => !(Number(entry.duration) > maxDurationSec));
  return { wanted, eligible: eligible.length, skippedLong: unique.length - eligible.length, selected: evenlySpaced(eligible, wanted) };
}

/** A bare channel URL means "its Shorts"; explicit tabs and playlists are respected. */
export function shortsUrl(source) {
  return /^https?:\/\/(www\.|m\.)?youtube\.com\/(@[^/?#]+|channel\/[^/?#]+|c\/[^/?#]+|user\/[^/?#]+)\/?$/i.test(source) ? `${source.replace(/\/$/, '')}/shorts` : source;
}

/** The YouTube id of a single-video URL (watch, shorts, youtu.be), else null. */
export function singleVideoId(source) {
  const match = source.match(/^https?:\/\/(?:(?:www|m)\.)?(?:youtube\.com\/(?:shorts\/|watch\?(?:[^#]*&)?v=)|youtu\.be\/)([\w-]{11})(?![\w-])/i);
  return match ? match[1] : null;
}

async function listRemote(source) {
  const ytDlp = await ytDlpPath();
  const { stdout } = await runProcess(ytDlp, ['--flat-playlist', '--playlist-end', String(LIMITS.listCap), '--dump-single-json', '--no-warnings', source], { timeoutMs: 120_000 });
  const parsed = JSON.parse(stdout);
  let entries = (parsed.entries || [parsed]).filter(Boolean);
  if (entries.length && entries.every(entry => entry._type === 'playlist' || Array.isArray(entry.entries))) {
    const tab = entries.find(entry => /\/shorts\/?$/.test(entry.url || '')) || entries.find(entry => /\/videos\/?$/.test(entry.url || '')) || entries[0];
    if (!tab.url) throw new Error('Could not find a Shorts or Videos tab for this channel; pass the tab URL directly.');
    return listRemote(tab.url);
  }
  return { parsed, entries };
}

export async function catalogSource(source, { count = LIMITS.defaultCount } = {}) {
  const warnings = [];
  let entries, kind, label = source;
  if (/^https?:\/\//i.test(source)) {
    const id = singleVideoId(source), target = shortsUrl(source);
    const { parsed, entries: listed } = id ? { parsed: {}, entries: [{ id, title: `Video ${id}`, url: source }] } : await listRemote(target);
    entries = listed.map((entry, index) => ({
      id: String(entry.id || index + 1), title: entry.title || `Video ${index + 1}`, duration: entry.duration,
      url: entry.url?.startsWith('http') ? entry.url : `https://www.youtube.com/watch?v=${entry.id}`,
      channel: entry.channel || parsed.channel || parsed.uploader || '', sourceIndex: index,
    }));
    kind = entries.length > 1 ? 'channel-or-playlist' : 'video';
  } else {
    const absolute = resolve(source), info = await stat(absolute);
    label = absolute;
    if (info.isFile()) {
      if (!VIDEO_EXTENSIONS.has(extname(absolute).toLowerCase())) throw new Error(`Unsupported video file: ${absolute}`);
      entries = [{ id: 'local-1', title: absolute.split('/').at(-1), path: absolute, sourceIndex: 0 }]; kind = 'local-file';
    } else {
      entries = (await readdir(absolute, { withFileTypes: true })).filter(item => item.isFile() && VIDEO_EXTENSIONS.has(extname(item.name).toLowerCase()))
        .map((item, index) => ({ id: `local-${index + 1}`, title: item.name, path: join(absolute, item.name), sourceIndex: index }));
      if (!entries.length) throw new Error(`No supported videos found in ${absolute}`);
      kind = 'local-folder';
    }
  }
  const picked = selectEntries(entries, { count, maxDurationSec: entries.length > 1 ? LIMITS.maxSeconds : Infinity });
  if (!picked.selected.length) throw new Error('No eligible videos found (everything listed was longer than the short-video limit).');
  if (picked.selected.length < LIMITS.recommendedMin && picked.selected.length > 1) warnings.push(`Only ${picked.selected.length} eligible videos found; patterns are lower confidence than a 10–20 video sample.`);
  if (picked.selected.length === 1) warnings.push('Single-video study: measurements describe this video only, not a channel style.');
  return { kind, source: label, available: entries.length, eligible: picked.eligible, requested: picked.wanted, selected: picked.selected, warnings };
}
