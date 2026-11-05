import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { runProcess } from './process.js';
import { projectRoot } from './environment.js';
import { lensToFov } from './blueprint.js';

export const ANALYSIS_VERSION = 2;
const analyser = join(projectRoot, 'analysis', 'analyze_video.py');
const GROUPS = ['head', 'shoulders', 'hands', 'torso', 'hips', 'legs'];
const fileId = id => String(id).replace(/[^a-z0-9_-]/gi, '_');

const finite = values => values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
const at = (sorted, p) => {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * p, low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
};
const round = (value, places = 3) => Number.isFinite(value) ? Number(value.toFixed(places)) : null;
/** Spread of one per-video statistic across videos. Videos with no value are left out, never counted as zero. */
export function distribution(values) {
  const sorted = finite(values);
  return { videos: sorted.length, median: round(at(sorted, .5)), p10: round(at(sorted, .1)), p90: round(at(sorted, .9)) };
}
const level = count => count >= 10 ? 'high' : count >= 5 ? 'medium' : 'low';
const exists = async path => { try { await access(path); return true; } catch { return false; } };

export async function loadCached(workspace, item, { maxSeconds, pose }) {
  try {
    const record = JSON.parse(await readFile(join(workspace, 'measurements', `${fileId(item.id)}.json`), 'utf8'));
    const fresh = record.version === ANALYSIS_VERSION && record.settings?.maxSeconds === maxSeconds && record.pose?.available === pose;
    return fresh && await exists(join(workspace, record.evidence.image)) ? record : null;
  } catch { return null; }
}

export async function analyseVideo({ item, sourcePath, normalizedPath, workspace, maxSeconds, env }) {
  const id = fileId(item.id);
  const measurementsDir = join(workspace, 'measurements'), evidenceDir = join(workspace, 'evidence');
  await mkdir(measurementsDir, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });
  const output = join(measurementsDir, `${id}.json`);
  const args = [analyser, sourcePath, normalizedPath, '--output', output, '--max-sec', String(maxSeconds), ...(env.pose ? [] : ['--no-pose'])];
  await runProcess(env.python, args, { timeoutMs: 600_000 });
  const measurement = JSON.parse(await readFile(output, 'utf8'));
  const evidencePath = join(evidenceDir, `${id}.jpg`);
  await runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(measurement.representativeFrame.timeSec), '-i', normalizedPath, '-frames:v', '1', '-q:v', '3', evidencePath], { timeoutMs: 60_000 });
  const record = {
    ...measurement,
    settings: { maxSeconds },
    source: { id: item.id, title: item.title, url: item.url || null, channel: item.channel || null, sourceIndex: item.sourceIndex },
    evidence: { image: relative(workspace, evidencePath), timeSec: measurement.representativeFrame.timeSec, frame: measurement.representativeFrame.frame },
  };
  await writeFile(output, JSON.stringify(record));
  return record;
}

export function aggregateMeasurements(measurements, catalog, { skipped = [], warnings = [], maxSeconds = 45, poseAvailable = true } = {}) {
  const posed = measurements.filter(item => item.pose?.usable);
  const per = (items, pick) => items.map(item => { try { return pick(item); } catch { return null; } });
  const steps = per(measurements, item => item.cadence.animationStepNativeFrames).filter(Number.isFinite);
  const counts = new Map(); steps.forEach(step => counts.set(step, (counts.get(step) || 0) + 1));
  const mode = steps.length ? [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;

  const cadence = {
    dominantStepNativeFrames: mode,
    stepNativeFrames: distribution(steps),
    estimatedContentFps: distribution(per(measurements, item => item.cadence.estimatedContentFps)),
    imageIntervalMs: distribution(per(measurements, item => item.cadence.imageIntervalMs.median)),
    duplicateFrameRatio: distribution(per(measurements, item => item.cadence.duplicateFrameRatio)),
    holdFrames: distribution(per(measurements, item => item.cadence.holdFrames.p90)),
    nativeFps: distribution(per(measurements, item => item.nativeFps)),
  };
  const shots = {
    cutsPerMinute: distribution(per(measurements, item => item.shots.cutsPerMinute)),
    lengthSec: { typical: distribution(per(measurements, item => item.shots.lengthSec.median)), short: distribution(per(measurements, item => item.shots.lengthSec.p10)), long: distribution(per(measurements, item => item.shots.lengthSec.p90)) },
  };
  const bodyMotion = posed.length ? Object.fromEntries(GROUPS.map(group => [group, {
    speedPerSec: distribution(per(posed, item => item.bodyMotion[group].speedPerSec.median)),
    peakSpeedPerSec: distribution(per(posed, item => item.bodyMotion[group].speedPerSec.p95)),
    accelerationPerSec2: distribution(per(posed, item => item.bodyMotion[group].accelerationPerSec2.median)),
  }])) : null;
  const talking = posed.filter(item => item.coSpeech);
  const coSpeechMotion = talking.length ? {
    mouthHeadCorrelation: distribution(per(talking, item => item.coSpeech.mouthHeadCorrelation)),
    mouthShoulderCorrelation: distribution(per(talking, item => item.coSpeech.mouthShoulderCorrelation)),
    mouthHandCorrelation: distribution(per(talking, item => item.coSpeech.mouthHandCorrelation)),
    headSpeedRatioActiveOverQuiet: distribution(per(talking, item => item.coSpeech.headSpeedMouthActive.median / item.coSpeech.headSpeedMouthQuiet.median)),
  } : null;

  const measuredPatterns = {
    cadence, shots, motionEnergy: distribution(per(measurements, item => item.motionEnergy.median)),
    bodyMotion, coSpeechMotion, snapEventsPer10s: posed.length ? distribution(per(posed, item => item.snapEvents.per10s)) : null,
  };
  const trackedRatios = measurements.filter(item => item.pose?.available).map(item => item.pose.trackedFrameRatio);
  const confidence = {
    analysedVideos: measurements.length, poseUsableVideos: posed.length,
    meanPoseTrackedFrameRatio: trackedRatios.length ? round(trackedRatios.reduce((a, b) => a + b, 0) / trackedRatios.length, 3) : 0,
    cadence: level(measurements.length), bodyMotion: poseAvailable ? level(posed.length) : 'unavailable',
    basis: 'native-rate cadence + 30fps landmark motion in shoulder-widths per second',
  };
  const allWarnings = [...warnings, ...(catalog.warnings || [])];
  if (poseAvailable && measurements.length > posed.length) allWarnings.push(`${measurements.length - posed.length} of ${measurements.length} videos had too little pose tracking (stylised or small figures); they count for cadence and cutting only.`);

  const blueprint = {
    schema: 'polystudio.motion-style-blueprint/v1', analysisVersion: ANALYSIS_VERSION, generatedAt: new Date().toISOString(),
    analysisClock: { fps: 30, constantFrameRate: true, cadenceMeasuredAt: 'native frame rate' },
    sourceStudy: { kind: catalog.kind, source: catalog.source, available: catalog.available, eligible: catalog.eligible, analysedVideos: measurements.length, skippedVideos: skipped.length, secondsPerVideo: maxSeconds, selection: 'evenly spaced across the newest listed videos' },
    measuredPatterns, confidence, warnings: allWarnings, skipped,
    videos: measurements.map(item => ({ id: item.source.id, title: item.source.title, url: item.source.url, nativeFps: item.nativeFps, analysedSec: item.analysedSec, step: item.cadence.animationStepNativeFrames, cuts: item.shots.cuts, poseUsable: item.pose.usable, poseTrackedFrameRatio: item.pose.trackedFrameRatio ?? null, evidence: item.evidence })),
  };
  blueprint.summary = summaryLines(blueprint);
  return blueprint;
}

const num = (value, places = 2) => Number.isFinite(value) ? String(round(value, places)) : '?';

export function summaryLines(blueprint) {
  const { cadence, shots, bodyMotion, coSpeechMotion, snapEventsPer10s } = blueprint.measuredPatterns;
  const lines = [];
  const step = cadence.dominantStepNativeFrames;
  lines.push(`Cadence: ${step ? `pictures change every ${step} native frame(s)` : 'step not determined'} (~${num(cadence.estimatedContentFps.median, 1)} drawings/s at ${num(cadence.nativeFps.median, 0)} fps source); ${num(cadence.duplicateFrameRatio.median * 100, 0)}% of frames repeat the previous picture; holds up to ${num(cadence.holdFrames.median, 0)} frames.`);
  lines.push(`Editing: a cut every ${num(shots.lengthSec.typical.median, 1)}s typically (short ${num(shots.lengthSec.short.median, 1)}s, long ${num(shots.lengthSec.long.median, 1)}s); ${num(shots.cutsPerMinute.median, 1)} cuts/min.`);
  if (bodyMotion) {
    lines.push(`Body speed (shoulder-widths/s, median / peak): ${GROUPS.map(group => `${group} ${num(bodyMotion[group].speedPerSec.median)}/${num(bodyMotion[group].peakSpeedPerSec.median)}`).join('; ')}.`);
    if (snapEventsPer10s) lines.push(`Accents: ~${num(snapEventsPer10s.median, 1)} sharp snap moments per 10s.`);
  }
  if (coSpeechMotion) lines.push(`Speech: head moves ${num(coSpeechMotion.headSpeedRatioActiveOverQuiet.median, 1)}x faster while the mouth is open than closed; mouth-head correlation ${num(coSpeechMotion.mouthHeadCorrelation.median)}.`);
  const { confidence: c } = blueprint;
  lines.push(`Confidence: ${c.analysedVideos} videos (cadence ${c.cadence}); ${c.poseUsableVideos} with usable pose (body motion ${c.bodyMotion}).`);
  return lines;
}

/** A PolyStudio story-format pack whose guidance carries the measured motion rules. */
export function toMotionPack(blueprint, { name = 'Measured motion style' } = {}) {
  const slug = `motion-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'study'}`;
  const { shots } = blueprint.measuredPatterns;
  const minShot = Math.max(0.5, round(shots.lengthSec.short.median ?? 1, 1)), maxShot = Math.min(30, Math.ceil((shots.lengthSec.long.median ?? 8) + 1));
  const guidance = ['MEASURED MOTION RULES (from real videos; follow the numbers, not adjectives)', ...blueprint.summary.map(line => `- ${line}`)].join('\n');
  return {
    id: slug, name, version: '1.0.0', type: 'story-format', guide: 'style-guide.md',
    format: {
      id: slug, label: name, icon: '✦', blurb: `Motion measured from ${blueprint.confidence.analysedVideos} short videos.`, guidance,
      limits: { maxShots: 24, maxPlanShots: 120, minShot, maxShot: Math.max(maxShot, minShot + 1) },
      beatSnap: false, facesCamera: false, fov: { close: lensToFov(50), other: lensToFov(35) }, videoPrompt: guidance,
    },
  };
}

export const styleGuideFromStudy = (blueprint, name) => `# ${name}\n\n${blueprint.summary.map(line => `- ${line}`).join('\n')}\n\n${blueprint.warnings.length ? `## Warnings\n\n${blueprint.warnings.map(line => `- ${line}`).join('\n')}\n\n` : ''}Source: ${blueprint.sourceStudy.source} (${blueprint.sourceStudy.analysedVideos} videos, first ${blueprint.sourceStudy.secondsPerVideo}s of each).\n`;

export async function writeStudy(workspace, blueprint, name) {
  const output = join(workspace, 'motion-style-blueprint.json');
  await writeFile(output, `${JSON.stringify(blueprint, null, 1)}\n`);
  await writeFile(join(workspace, 'summary.md'), styleGuideFromStudy(blueprint, name));
  const packDir = join(workspace, 'pack');
  await mkdir(packDir, { recursive: true });
  await writeFile(join(packDir, 'pack.json'), `${JSON.stringify(toMotionPack(blueprint, { name }), null, 2)}\n`);
  await writeFile(join(packDir, 'style-guide.md'), styleGuideFromStudy(blueprint, name));
  return { output, summary: join(workspace, 'summary.md'), packDir };
}
