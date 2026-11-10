import { cpus } from 'node:os';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { explainDownloadError, preflight } from './environment.js';
import { LIMITS, catalogSource } from './source-catalog.js';
import { acquire, normalize } from './video-ingest.js';
import { aggregateMeasurements, analyseVideo, loadCached, writeStudy } from './style-analysis.js';
import { reconstructStudy } from './reconstruction.js';

const running = new Map(); // workspace -> promise, so one workspace never runs twice
const clamp = (value, min, max, fallback) => Number.isFinite(Number(value)) && value !== null && value !== '' ? Math.min(max, Math.max(min, Number(value))) : fallback;

async function setStatus(workspace, patch) {
  const file = join(workspace, 'status.json');
  let current = {};
  try { current = JSON.parse(await readFile(file, 'utf8')); } catch { /* first write */ }
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await writeFile(file, JSON.stringify(next));
  return next;
}

export async function studyStatus(outputDir) {
  try { return JSON.parse(await readFile(join(resolve(outputDir), 'status.json'), 'utf8')); }
  catch { return { state: 'unknown', message: 'No study has been started in this folder.' }; }
}

/** Run the whole study; resolves with a compact result. Failures on single videos are recorded, not fatal. */
async function execute(input, workspace) {
  const source = String(input.source).trim();
  const maxSeconds = clamp(input.maxSecondsPerVideo, 10, LIMITS.maxSeconds, LIMITS.defaultSeconds);
  const count = clamp(input.videoCount, 1, LIMITS.maxCount, LIMITS.defaultCount);
  const concurrency = Math.round(clamp(input.concurrency, 1, 3, Math.min(2, Math.max(1, cpus().length - 1))));
  const keepSources = input.keepSources === true;
  const name = String(input.name || 'Measured motion style');

  const env = await preflight({ remote: /^https?:\/\//i.test(source) });
  await setStatus(workspace, { stage: 'cataloguing', message: 'Listing videos…' });
  const catalog = await catalogSource(source, { count });
  const total = catalog.selected.length;
  await setStatus(workspace, { stage: 'analysing', total, done: 0, failed: 0, message: `Analysing ${total} video(s)…` });

  const results = new Array(total).fill(null), skipped = [];
  let next = 0, done = 0, streak = 0, aborted = false;
  const worker = async () => {
    while (next < total && !aborted) {
      const index = next++, item = catalog.selected[index];
      try {
        results[index] = await loadCached(workspace, item, { maxSeconds, pose: env.pose });
        if (!results[index]) {
          const sourcePath = await acquire(item, workspace, maxSeconds);
          const normalizedPath = await normalize(sourcePath, item, workspace, maxSeconds);
          results[index] = await analyseVideo({ item, sourcePath, normalizedPath, workspace, maxSeconds, env });
          if (!keepSources) {
            await rm(normalizedPath, { force: true });
            if (!item.path) await rm(sourcePath, { force: true });
          }
        }
        streak = 0;
      } catch (error) {
        skipped.push({ id: item.id, title: item.title, reason: explainDownloadError(String(error.message).split('\n')[0]).slice(0, 420) });
        // three failures in a row with nothing analysed means the setup is broken, not the videos: stop early
        if (++streak >= 3 && !results.some(Boolean)) aborted = true;
      }
      done += 1;
      await setStatus(workspace, { done, failed: skipped.length, message: `${done}/${total} videos processed${skipped.length ? `, ${skipped.length} skipped` : ''}` });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));

  const measurements = results.filter(Boolean);
  if (!measurements.length) throw new Error(`No video could be analysed. First problem: ${skipped[0]?.reason || 'unknown'}`);
  const blueprint = aggregateMeasurements(measurements, catalog, { skipped, warnings: env.warnings, maxSeconds, poseAvailable: env.pose });
  const files = await writeStudy(workspace, blueprint, name);
  await setStatus(workspace, { stage: 'reconstructing', message: 'Selecting and fitting a measured visual reconstruction…' });
  const reconstruction = await reconstructStudy({ workspace, measurements, env, quality: ['standard', 'high', 'ultra'].includes(input.reconstructionQuality) ? input.reconstructionQuality : 'standard' });
  const first = blueprint.videos[0];
  return {
    output: files.output, summaryFile: files.summary, packDir: files.packDir, workspace,
    videosAnalysed: measurements.length, skipped: skipped.slice(0, 5), analysisFps: 30,
    headline: blueprint.summary, confidence: blueprint.confidence, warnings: blueprint.warnings,
    evidence: { source: { title: first.title }, image: first.evidence.image }, evidenceFrame: first.evidence,
    reconstruction,
  };
}

/** Foreground by default; `background: true` returns immediately and progress is read from status.json. */
export async function runStudy(input) {
  if (!input.source || typeof input.source !== 'string') throw new Error('source is required');
  if (!input.outputDir || typeof input.outputDir !== 'string') throw new Error('outputDir is required');
  const workspace = resolve(input.outputDir);
  if (running.has(workspace)) throw new Error('A study is already running in this folder; read its progress with style_analysis_status.');
  await mkdir(workspace, { recursive: true });
  await setStatus(workspace, { state: 'running', stage: 'starting', startedAt: new Date().toISOString(), done: 0, total: 0, failed: 0, error: null, result: null });
  const job = execute(input, workspace)
    .then(result => setStatus(workspace, { state: 'done', stage: 'done', message: 'Study complete', result }).then(() => result))
    .catch(async error => { await setStatus(workspace, { state: 'failed', stage: 'failed', error: error.message }); throw error; })
    .finally(() => running.delete(workspace));
  running.set(workspace, job);
  if (input.background) {
    job.catch(() => {}); // the failure is recorded in status.json
    return { started: true, workspace, status: 'Use style_analysis_status with this outputDir to follow progress (about 1–3 minutes per video).' };
  }
  return job;
}

export const isRunning = () => running.size > 0;
