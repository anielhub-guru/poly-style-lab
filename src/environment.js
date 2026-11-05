import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './process.js';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const SETUP = 'Run: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt';
let cached;

async function exists(path) { try { await access(path); return true; } catch { return false; } }
const works = (command, args) => runProcess(command, args, { timeoutMs: 30_000 }).then(() => true, () => false);

/** YT_DLP overrides everything (e.g. a Homebrew or standalone binary); then the project venv; then PATH. */
export async function ytDlpPath() {
  if (process.env.YT_DLP) return process.env.YT_DLP;
  const venv = join(projectRoot, '.venv', 'bin', 'yt-dlp');
  return (await exists(venv)) ? venv : 'yt-dlp';
}

/** Turn a raw yt-dlp failure into something fixable. */
export function explainDownloadError(message) {
  const stale = /reloaded|sign in|unable to extract|nsig|player response|HTTP Error 4(03|29)|not a bot/i.test(message);
  return stale ? `${message} — YouTube changed; update yt-dlp (needs Python 3.10+: \`uv venv --python 3.12 .venv && uv pip install -U -r requirements.txt\`), set YT_DLP to a current yt-dlp binary, or set COBALT_API_URL to a Cobalt instance as a fallback.` : message;
}

/** Pick the best interpreter: the project venv with pose tracking, else any Python with numpy. */
async function pickPython() {
  const venv = join(projectRoot, '.venv', 'bin', 'python');
  const candidates = (await exists(venv)) ? [venv, 'python3'] : ['python3'];
  let numpyOnly = null;
  for (const python of candidates) {
    if (await works(python, ['-c', 'import cv2, mediapipe, numpy'])) return { python, pose: true, numpy: true };
    if (!numpyOnly && await works(python, ['-c', 'import numpy'])) numpyOnly = { python, pose: false, numpy: true };
  }
  return numpyOnly || { python: candidates[0], pose: false, numpy: false };
}

/** Verify the toolchain once and say exactly what is missing. Pose tracking is optional; cadence, cuts and motion energy are not. */
export async function preflight({ remote = false } = {}) {
  if (!cached) cached = { ...(await pickPython()), ffmpeg: await works('ffmpeg', ['-version']), ytDlp: await works(await ytDlpPath(), ['--version']) };
  const problems = [];
  if (!cached.ffmpeg) problems.push('ffmpeg is not on PATH (install it, e.g. `brew install ffmpeg`)');
  if (!cached.numpy) problems.push(`Python numpy is missing. ${SETUP}`);
  if (remote && !cached.ytDlp && !process.env.COBALT_API_URL) problems.push(`yt-dlp is missing. ${SETUP}`);
  if (problems.length) { cached = undefined; throw new Error(`Analysis toolchain incomplete: ${problems.join('; ')}.`); }
  return { ...cached, warnings: cached.pose ? [] : [`mediapipe/opencv not installed: pose tracking skipped; only cadence, cuts and motion energy were measured. ${SETUP}`] };
}
