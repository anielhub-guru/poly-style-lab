import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './process.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const python = join(projectRoot, '.venv', 'bin', 'python');
const analyser = join(projectRoot, 'analysis', 'analyze_video.py');

const numeric = values => values.filter(Number.isFinite);
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const distribution = values => {
  const sorted = numeric(values).sort((a, b) => a - b);
  const at = p => sorted.length ? sorted[Math.round((sorted.length - 1) * p)] : 0;
  return { samples: sorted.length, mean: Number(mean(sorted).toFixed(6)), median: Number(at(.5).toFixed(6)), p10: Number(at(.1).toFixed(6)), p90: Number(at(.9).toFixed(6)) };
};

export async function analyseVideo(item, workspace, onProgress = () => {}) {
  const measurementsDir = join(workspace, 'measurements');
  const evidenceDir = join(workspace, 'evidence');
  await mkdir(measurementsDir, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });
  const output = join(measurementsDir, `${item.id}.json`);
  onProgress({ stage: 'measure', title: item.title, fps: 30 });
  await runProcess(python, [analyser, item.normalizedPath, '--output', output]);
  const measurement = JSON.parse(await readFile(output, 'utf8'));
  const evidencePath = join(evidenceDir, `${item.id}.jpg`);
  await runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(measurement.representativeFrame.timeSec), '-i', item.normalizedPath, '-frames:v', '1', '-q:v', '2', evidencePath]);
  return { ...measurement, source: { id: item.id, title: item.title, url: item.url || null, channel: item.channel || null, sourceIndex: item.sourceIndex, nativeFps: item.nativeFps, nativeDurationSec: item.nativeDurationSec }, evidence: { image: relative(workspace, evidencePath), timeSec: measurement.representativeFrame.timeSec, frame: measurement.representativeFrame.frame } };
}

export function aggregateMeasurements(measurements, catalog) {
  const groups = ['head', 'shoulders', 'hands', 'torso', 'hips', 'legs'];
  const bodyMotion = Object.fromEntries(groups.map(group => [group, {
    speedNormalizedPerSec: distribution(measurements.map(item => item.bodyMotion[group].speedNormalizedPerSec.median)),
    peakSpeedNormalizedPerSec: distribution(measurements.map(item => item.bodyMotion[group].speedNormalizedPerSec.p95)),
    accelerationNormalizedPerSec2: distribution(measurements.map(item => item.bodyMotion[group].accelerationNormalizedPerSec2.median)),
  }]));
  const cadence = {
    duplicateFrameRatio: distribution(measurements.map(item => item.frameCadence.duplicateFrameRatio)),
    medianHoldFrames: distribution(measurements.map(item => item.frameCadence.holdLengthsFrames.median)),
    p90HoldFrames: distribution(measurements.map(item => item.frameCadence.holdLengthsFrames.p90)),
  };
  const coSpeechMotion = {
    mouthHeadCorrelation: distribution(measurements.map(item => item.faceMotion.mouthHeadCorrelation)),
    mouthShoulderCorrelation: distribution(measurements.map(item => item.faceMotion.mouthShoulderCorrelation)),
    mouthHandCorrelation: distribution(measurements.map(item => item.faceMotion.mouthHandCorrelation)),
    headSpeedWhileMouthActive: distribution(measurements.map(item => item.faceMotion.headSpeedWhileMouthActive.median)),
    headSpeedWhileMouthQuiet: distribution(measurements.map(item => item.faceMotion.headSpeedWhileMouthQuiet.median)),
  };
  const evidence = measurements.map(item => ({ source: item.source, representativeFrame: item.evidence, trackedFrameRatio: item.video.trackedFrameRatio, snapEventCount: item.snapEvents.length }));
  return {
    schema: 'polystudio.motion-style-blueprint/v1',
    generatedAt: new Date().toISOString(),
    analysisClock: { fps: 30, frameDurationMs: 33.333333, constantFrameRate: true },
    sourceStudy: { kind: catalog.kind, source: catalog.source, availableVideos: catalog.available, analysedVideos: measurements.length, selection: 'evenly-spaced-across-source-order' },
    measuredPatterns: { cadence, bodyMotion, coSpeechMotion, snapEventsPerVideo: distribution(measurements.map(item => item.snapEvents.length)) },
    confidence: { analysedVideos: measurements.length, meanPoseTrackedFrameRatio: Number(mean(measurements.map(item => item.video.trackedFrameRatio)).toFixed(4)), basis: '30fps-frame-and-landmark-measurements' },
    evidence,
    perVideoMeasurements: measurements,
    polystudio: { motionContract: { fps: 30, cadence, bodyMotion, coSpeechMotion }, evidenceFrame: evidence[0]?.representativeFrame || null },
  };
}

export async function writeStudy(workspace, blueprint) {
  const output = join(workspace, 'motion-style-blueprint.json');
  await writeFile(output, `${JSON.stringify(blueprint, null, 2)}\n`);
  return output;
}
