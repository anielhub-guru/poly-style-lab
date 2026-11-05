import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { evenlySpaced, selectEntries, shortsUrl, singleVideoId } from '../src/source-catalog.js';
import { aggregateMeasurements, distribution, toMotionPack } from '../src/style-analysis.js';

const exec = promisify(execFile);
const GROUPS = ['head', 'shoulders', 'hands', 'torso', 'hips', 'legs'];
const stat = (median, p95 = median * 2) => ({ samples: 100, median, p95 });
const measurement = (id, { usable = true, step = 2, scale = 1 } = {}) => ({
  version: 2, nativeFps: 30, analysedSec: 30,
  cadence: { animationStepNativeFrames: step, estimatedContentFps: 30 / step, imageIntervalMs: stat(33 * step), duplicateFrameRatio: 1 - 1 / step, holdFrames: { p90: step - 1 } },
  shots: { cuts: 5, cutsPerMinute: 10, lengthSec: { median: 3, p10: 1.5, p90: 5 } }, motionEnergy: stat(4),
  motion: { regionShare: { top: 0.7, middle: 0.2, bottom: 0.1, left: 0.3, center: 0.4, right: 0.3 }, activeAreaRatio: stat(0.03), energyPerSec: stat(30), burstiness: 2, accents: { per10s: 2 } },
  pose: { available: true, usable, trackedFrameRatio: usable ? 0.8 : 0.05 },
  bodyMotion: usable ? Object.fromEntries(GROUPS.map(group => [group, { speedPerSec: stat(0.5 * scale), accelerationPerSec2: stat(3 * scale) }])) : Object.fromEntries(GROUPS.map(group => [group, { speedPerSec: { samples: 0 }, accelerationPerSec2: { samples: 0 } }])),
  coSpeech: usable ? { mouthHeadCorrelation: 0.5, mouthShoulderCorrelation: null, mouthHandCorrelation: 0.1, headSpeedMouthActive: stat(0.6), headSpeedMouthQuiet: stat(0.3) } : null,
  snapEvents: usable ? { per10s: 3 } : null,
  source: { id, title: `Video ${id}` }, evidence: { image: `evidence/${id}.jpg`, timeSec: 1.5, frame: 45 },
});
const catalog = { kind: 'channel-or-playlist', source: 'x', available: 20, eligible: 12, warnings: [] };

test('selection spreads the sample, drops duplicates and over-long uploads, and clamps the count', () => {
  assert.deepEqual(evenlySpaced(Array.from({ length: 100 }, (_, i) => i), 10), [0, 11, 22, 33, 44, 55, 66, 77, 88, 99]);
  const picked = selectEntries([{ id: 'a', duration: 30 }, { id: 'a', duration: 30 }, { id: 'b', duration: 900 }, { id: 'c' }], { count: 99, maxDurationSec: 180 });
  assert.deepEqual(picked.selected.map(entry => entry.id), ['a', 'c']);
  assert.equal(picked.wanted, 20);
  assert.equal(picked.skippedLong, 1);
});

test('a bare channel URL means its Shorts; explicit tabs are respected', () => {
  assert.equal(shortsUrl('https://www.youtube.com/@abc'), 'https://www.youtube.com/@abc/shorts');
  assert.equal(shortsUrl('https://youtube.com/@abc/videos'), 'https://youtube.com/@abc/videos');
  assert.equal(shortsUrl('https://www.youtube.com/watch?v=xyz'), 'https://www.youtube.com/watch?v=xyz');
});

test('distribution ignores missing values instead of treating them as zero', () => {
  assert.deepEqual(distribution([null, undefined, NaN, 2, 4]), { videos: 2, median: 3, p10: 2.2, p90: 3.8 });
});

test('videos without usable pose still count for cadence but not for body motion', () => {
  const blueprint = aggregateMeasurements([measurement('a'), measurement('b', { scale: 3 }), measurement('c', { usable: false })], catalog);
  assert.equal(blueprint.measuredPatterns.cadence.stepNativeFrames.videos, 3);
  assert.equal(blueprint.measuredPatterns.bodyMotion.head.speedPerSec.videos, 2);
  assert.equal(blueprint.measuredPatterns.bodyMotion.head.speedPerSec.median, 1);
  assert.equal(blueprint.confidence.poseUsableVideos, 2);
  assert.ok(blueprint.warnings.some(line => line.includes('1 of 3')));
  assert.equal(blueprint.measuredPatterns.coSpeechMotion.mouthShoulderCorrelation.videos, 0);
  assert.ok(blueprint.summary.length <= 8, 'summary stays compact for agents');
  assert.match(blueprint.summary.join('\n'), /Movement: 70% top \/ 20% middle \/ 10% bottom third; localized \(limited animation\)/);
  assert.ok(JSON.stringify(blueprint).length < 20_000, 'blueprint stays compact');
});

test('a study with no pose still produces a cadence and cutting contract and a valid pack', () => {
  const none = [measurement('a', { usable: false }), measurement('b', { usable: false })].map(item => ({ ...item, pose: { available: false, usable: false } }));
  const blueprint = aggregateMeasurements(none, catalog, { poseAvailable: false });
  assert.equal(blueprint.measuredPatterns.bodyMotion, null);
  assert.equal(blueprint.confidence.bodyMotion, 'unavailable');
  assert.equal(blueprint.measuredPatterns.motion.regionShare.top.median, 0.7, 'landmark-free movement needs no pose');
  assert.match(toMotionPack(blueprint).format.guidance, /Movement:/);
  const pack = toMotionPack(blueprint, { name: 'Test study' });
  assert.equal(pack.type, 'story-format');
  assert.ok(Number.isFinite(pack.format.limits.minShot) && pack.format.limits.maxShot > pack.format.limits.minShot);
  assert.match(pack.format.guidance, /Cadence: pictures change every 2/);
});

const python = await exec('python3', ['-c', 'import numpy']).then(() => 'python3', () => null);
const ffmpeg = await exec('ffmpeg', ['-version']).then(() => true, () => false);
test('native-rate analyser recovers animating on twos and a hard cut from a real clip', { skip: !(python && ffmpeg) && 'needs ffmpeg and numpy' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'psl-'));
  const clip = join(dir, 'twos.mp4'), out = join(dir, 'out.json');
  // 15 distinct pictures/s shown twice at 30 fps, hard cut at 3 s
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x568:rate=15:duration=3', '-f', 'lavfi', '-i', 'mandelbrot=size=320x568:rate=15',
    '-filter_complex', '[1:v]trim=duration=3,setpts=PTS-STARTPTS[b];[0:v][b]concat=n=2:v=1[o];[o]fps=30[f]', '-map', '[f]', '-pix_fmt', 'yuv420p', '-y', clip]);
  const script = fileURLToPath(new URL('../analysis/analyze_video.py', import.meta.url));
  await exec(python, [script, clip, clip, '--output', out, '--no-pose']);
  const result = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(result.cadence.animationStepNativeFrames, 2);
  assert.equal(result.cadence.intervalShare.twos, 1);
  assert.equal(result.shots.cuts, 1);
  assert.equal(result.shots.lengthSec.median, 3);
  assert.equal(result.pose.available, false);
});

test('pose pass converts landmark motion to shoulder-widths per second, skipping held frames', { skip: !(python && ffmpeg) && 'needs ffmpeg and numpy' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'psl-'));
  const clip = join(dir, 'twos.mp4'), normalized = join(dir, 'norm.mp4'), out = join(dir, 'out.json');
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x568:rate=15:duration=6', '-vf', 'fps=30', '-pix_fmt', 'yuv420p', '-y', clip]);
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', clip, '-an', '-vf', "fps=30,scale=-2:'min(480,ih)'", '-pix_fmt', 'yuv420p', '-y', normalized]);
  const script = fileURLToPath(new URL('../analysis/analyze_video.py', import.meta.url));
  const stubs = fileURLToPath(new URL('./fixtures/stubs', import.meta.url));
  await exec(python, [script, clip, normalized, '--output', out], { env: { ...process.env, PYTHONPATH: stubs } });
  const result = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(result.pose.usable, true);
  assert.equal(result.pose.scaleBasis, 'shoulder-width');
  assert.equal(result.pose.trackedFrameRatio, 1);
  assert.ok(result.pose.processedFrames < result.pose.frames * 0.6, 'held frames are not re-processed');
  const head = result.bodyMotion.head.speedPerSec.median;
  assert.ok(head > 0.7 && head < 1.3, `head about 1 shoulder-width/s, got ${head}`);
  assert.equal(result.bodyMotion.shoulders.speedPerSec.median, 0);
  assert.equal(result.bodyMotion.hands.speedPerSec.median, 0);
  assert.ok(result.coSpeech && Number.isFinite(result.coSpeech.mouthHeadCorrelation), 'mouth and head are correlated per frame');
  assert.ok(result.coSpeech.headSpeedMouthActive.samples > 0 && result.coSpeech.headSpeedMouthQuiet.samples > 0);
  assert.ok(result.snapEvents.count >= 0 && Array.isArray(result.snapEvents.top));
});

test('single-video URLs are recognised without listing; channels are not', () => {
  assert.equal(singleVideoId('https://www.youtube.com/shorts/GmBXKjzM11w'), 'GmBXKjzM11w');
  assert.equal(singleVideoId('https://youtu.be/dQw4w9WgXcQ?t=3'), 'dQw4w9WgXcQ');
  assert.equal(singleVideoId('https://www.youtube.com/@abc'), null);
});

test('landmark-free motion finds WHERE a small local movement happens, and still reads its cadence', { skip: !(python && ffmpeg) && 'needs ffmpeg and numpy' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'psl-'));
  const clip = join(dir, 'box.mp4'), out = join(dir, 'out.json');
  // a small box sweeping through the TOP third of an otherwise still frame, 15 distinct pictures/s shown twice
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=gray:s=320x568:r=15:d=6', '-f', 'lavfi', '-i', 'color=red:s=40x40:r=15:d=6',
    '-filter_complex', "[0][1]overlay=x='mod(n*12,260)':y=60,fps=30", '-pix_fmt', 'yuv420p', '-y', clip]);
  const script = fileURLToPath(new URL('../analysis/analyze_video.py', import.meta.url));
  await exec(python, [script, clip, clip, '--output', out, '--no-pose']);
  const result = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(result.cadence.animationStepNativeFrames, 2, 'small local motion must not be mistaken for held frames');
  assert.ok(result.motion.regionShare.top > 0.95, `motion is in the top third, got ${result.motion.regionShare.top}`);
  assert.ok(result.motion.activeAreaRatio.median < 0.05, 'localized, not full-frame');
});
