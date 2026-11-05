import test from 'node:test';
import assert from 'node:assert/strict';
import { BLUEPRINT_SCHEMA, PRESETS, lensToFov, normalizeBlueprint, styleGuideMarkdown, toPolyStudioPack } from '../src/blueprint.js';

test('normalizes a complete versioned Localy blueprint', () => {
  const blueprint = normalizeBlueprint(PRESETS['stormbound-shonen']);
  assert.equal(blueprint.schema, BLUEPRINT_SCHEMA);
  assert.equal(blueprint.metadata.slug, 'stormbound-shonen');
  assert.equal(blueprint.canvas.aspectRatio, '16:9');
  assert.equal(blueprint.palette.reduce((sum, swatch) => sum + swatch.share, 0), 100);
  assert.equal(blueprint.shotGrammar.length, 5);
  assert.match(blueprint.promptContract.master, /CAMERA: default 35mm/);
  assert.match(blueprint.promptContract.negative, /franchise/i);
});

test('transliterates Unicode names into stable export slugs', () => {
  const blueprint = normalizeBlueprint({ ...PRESETS['stormbound-shonen'], slug: 'Stormbound Shōnen' });
  assert.equal(blueprint.metadata.slug, 'stormbound-shonen');
});

test('normalizes colour shares and clamps measurable fields', () => {
  const blueprint = normalizeBlueprint({ ...PRESETS['stormbound-shonen'], frameRate: 200, focalLength: 2, palette: [{ role: 'a', value: '#ffffff', share: 1 }, { role: 'b', value: '#000000', share: 3 }] });
  assert.equal(blueprint.canvas.frameRate, 60);
  assert.equal(blueprint.camera.defaultLensMm, 14);
  assert.deepEqual(blueprint.palette.map(item => item.share), [25, 75]);
});

test('exports a valid PolyStudio declarative story-format pack', () => {
  const blueprint = normalizeBlueprint(PRESETS['stormbound-shonen']);
  const pack = toPolyStudioPack(blueprint);
  assert.equal(pack.type, 'story-format');
  assert.equal(pack.format.id, 'stormbound-shonen');
  assert.equal(pack.format.refineCamera, undefined);
  assert.ok(pack.format.limits.minShot >= 0.5);
  assert.match(pack.format.videoPrompt, /AVOID:/);
  assert.equal(pack.format.fov.other, lensToFov(35));
});

test('style guide contains the measured shot grammar and exclusions', () => {
  const guide = styleGuideMarkdown(normalizeBlueprint(PRESETS['quiet-editorial']));
  assert.match(guide, /Measured visual contract/);
  assert.match(guide, /Editorial Tableau/);
  assert.match(guide, /Glossy 3D materials/);
});

for (const id of Object.keys(PRESETS)) {
  test(`a saved ${id} blueprint survives being loaded again (CLI/MCP round trip)`, () => {
    const once = normalizeBlueprint({ ...PRESETS[id], name: 'My Edited Name', keyAngle: 12, continuity: ['Only this lock'] });
    const twice = normalizeBlueprint(JSON.parse(JSON.stringify(once)));
    const stable = value => ({ ...value, metadata: { ...value.metadata, generatedAt: '' } });
    assert.deepEqual(stable(twice), stable(once));
    assert.equal(twice.metadata.name, 'My Edited Name');
    assert.equal(twice.lighting.keyAngleDeg, 12);
    assert.deepEqual(twice.continuityLocks, ['Only this lock']);
    assert.equal(twice.camera.defaultLensMm, PRESETS[id].focalLength);
  });
}

test('zero is a real value, not a request for the default', () => {
  const blueprint = normalizeBlueprint({ ...PRESETS['stormbound-shonen'], keyAngle: 0, horizon: 0, lineVariation: 0, fillRatio: 0 });
  assert.equal(blueprint.lighting.keyAngleDeg, 0);
  assert.equal(blueprint.camera.horizonPercent, 0);
  assert.equal(blueprint.rendering.lineVariationPercent, 0);
  assert.equal(blueprint.lighting.fillToKeyRatio, 0);
});

test('prompts use normalized values and never print undefined', () => {
  const blueprint = normalizeBlueprint({ ...PRESETS['stormbound-shonen'], character: { silhouette: 'only this' }, frameRate: 500, focalLength: 1, motion: { impactFrames: 99 } });
  assert.doesNotMatch(blueprint.promptContract.master, /undefined|NaN/);
  assert.match(blueprint.promptContract.master, /only this/);
  assert.equal(blueprint.motion.impactFrames, 12);
  assert.match(blueprint.promptContract.master, /default 14mm/);
});

test('an empty shot list exports finite limits and duplicate shot labels get unique ids', () => {
  const empty = toPolyStudioPack(normalizeBlueprint({ ...PRESETS['stormbound-shonen'], shotGrammar: [] }));
  assert.ok(Object.values(empty.format.limits).every(Number.isFinite));
  const shot = { id: 'same', label: 'Same', size: 'wide', lensMm: 35, durationSec: 2, angleDeg: 0, move: 'locked', purpose: 'x' };
  const ids = normalizeBlueprint({ ...PRESETS['stormbound-shonen'], shotGrammar: [shot, shot, shot] }).shotGrammar.map(item => item.id);
  assert.equal(new Set(ids).size, 3);
});
