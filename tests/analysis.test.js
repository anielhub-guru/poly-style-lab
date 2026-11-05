import test from 'node:test';
import assert from 'node:assert/strict';
import { evenlySpaced } from '../src/source-catalog.js';
import { aggregateMeasurements } from '../src/style-analysis.js';

const metric = (median, p95 = median * 2) => ({ samples: 300, mean: median, median, p10: median / 2, p90: p95, p95, max: p95 * 1.2 });
const measurement = (id, scale) => ({
  analysisClock: { fps: 30 },
  video: { trackedFrameRatio: .8 + scale / 100 },
  source: { id, title: `Video ${id}`, nativeFps: 24 },
  evidence: { image: `evidence/${id}.jpg`, timeSec: 1.5, frame: 45 },
  frameCadence: { duplicateFrameRatio: .4 + scale / 100, holdLengthsFrames: metric(2 + scale), frameDifference: metric(4), highMotionThreshold: 8 },
  bodyMotion: Object.fromEntries(['head', 'shoulders', 'hands', 'torso', 'hips', 'legs'].map(group => [group, { speedNormalizedPerSec: metric(.02 * scale), accelerationNormalizedPerSec2: metric(.08 * scale) }])),
  faceMotion: { mouthHeadCorrelation: .6, mouthShoulderCorrelation: .4, mouthHandCorrelation: .2, headSpeedWhileMouthActive: metric(.05), headSpeedWhileMouthQuiet: metric(.01) },
  snapEvents: Array.from({ length: scale }, (_, index) => ({ frame: index })),
});

test('channel selection spans the full source order', () => {
  const source = Array.from({ length: 100 }, (_, index) => index);
  const selected = evenlySpaced(source, 10);
  assert.deepEqual(selected, [0, 11, 22, 33, 44, 55, 66, 77, 88, 99]);
});

test('aggregates measured 30 FPS evidence into a PolyStudio motion contract', () => {
  const blueprint = aggregateMeasurements([measurement('a', 1), measurement('b', 2)], { kind: 'channel-or-playlist', source: 'channel', available: 20 });
  assert.equal(blueprint.schema, 'polystudio.motion-style-blueprint/v1');
  assert.equal(blueprint.analysisClock.fps, 30);
  assert.equal(blueprint.sourceStudy.analysedVideos, 2);
  assert.equal(blueprint.polystudio.motionContract.fps, 30);
  assert.equal(blueprint.evidence[0].representativeFrame.frame, 45);
  assert.ok(blueprint.measuredPatterns.bodyMotion.hands.speedNormalizedPerSec.samples > 0);
});
