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
