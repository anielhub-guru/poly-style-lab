import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Optional fallback downloader: a Cobalt API instance (https://github.com/imputnet/cobalt).
 *  The public api.cobalt.tools requires a key or browser session, so use your own instance or key:
 *  COBALT_API_URL=http://localhost:9000/  COBALT_API_KEY=... (optional) */
export const cobaltConfigured = () => Boolean(process.env.COBALT_API_URL);

const authHeader = () => process.env.COBALT_API_KEY ? { authorization: `Api-Key ${process.env.COBALT_API_KEY}` } : {};

/** Ask Cobalt for a 480p H.264 video-only file, then stream it to `target` (aborting past `maxBytes`). Returns the path. */
export async function cobaltDownload(url, target, { maxBytes = 60_000_000, timeoutMs = 120_000 } = {}) {
  const endpoint = process.env.COBALT_API_URL;
  const response = await fetch(endpoint, {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json', 'content-type': 'application/json', ...authHeader() },
    body: JSON.stringify({ url, videoQuality: '480', youtubeVideoCodec: 'h264', downloadMode: 'mute', filenameStyle: 'basic' }),
  });
  const answer = await response.json().catch(() => ({}));
  if (answer.status === 'error' || !response.ok) throw new Error(`cobalt: ${answer.error?.code || `HTTP ${response.status}`}`);
  const link = answer.status === 'picker' ? answer.picker?.find(item => item.type === 'video')?.url : answer.url;
  if (!link) throw new Error(`cobalt: unexpected answer "${answer.status}"`);

  const file = await fetch(link, { signal: AbortSignal.timeout(timeoutMs) });
  if (!file.ok || !file.body) throw new Error(`cobalt: download failed (HTTP ${file.status})`);
  let bytes = 0;
  const limit = async function* (source) { for await (const chunk of source) { bytes += chunk.length; if (bytes > maxBytes) throw new Error(`cobalt: file larger than ${Math.round(maxBytes / 1e6)} MB; use a Short`); yield chunk; } };
  try { await pipeline(Readable.fromWeb(file.body), limit, createWriteStream(target)); }
  catch (error) { await rm(target, { force: true }); throw error; }
  return target;
}
