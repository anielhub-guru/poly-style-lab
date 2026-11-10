import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { reconstructStudy } from '../src/reconstruction.js';
import { embedRigInAikiScene, loadAikiScene, validateAikiScene } from '../src/aikiscene.js';

const exec = promisify(execFile);
const python = await exec('python3', ['-c', 'import numpy']).then(() => 'python3', () => null);
const ffmpeg = await exec('ffmpeg', ['-version']).then(() => true, () => false);
const benchmark = fileURLToPath(new URL('../analysis/hybrid_benchmark.py', import.meta.url));
const temporalBenchmark = fileURLToPath(new URL('../analysis/temporal_benchmark.py', import.meta.url));
const temporalTracker = fileURLToPath(new URL('../analysis/track_components.py', import.meta.url));

const makeImage = async (path, filter) => exec('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0xa8d4f0:s=320x180',
  '-vf', filter, '-frames:v', '1', '-y', path,
]);

test('numeric classifier selects strategies without subject names or fixed track IDs', { skip: !python && 'needs python' }, async () => {
  const source = `
import json
from analysis.rig_characters import classify_subject
def classify(width, height, compactness, palette, track, scene="semantic-layered-2d"):
    layer={"boundsPx":[0,0,width,height],"areaPx":round(width*height*compactness),"palette":["#000"]*palette}
    return classify_subject(layer,track,scene)[:2]
cases={
 "articulated":classify(30,90,.55,10,{"displacementPx":14,"persistence":1,"referenceMaskRuns":[[y,5,25] for y in range(40)]}),
 "spline":classify(30,60,.18,8,{"displacementPx":3,"persistence":1,"referenceMaskRuns":[[y,10,14] for y in range(58)]}),
 "rigid":classify(60,40,.7,2,{"displacementPx":0,"persistence":1,"referenceMaskRuns":[[y,5,55] for y in range(35)]}),
 "billboard":classify(30,80,.5,6,None,"hybrid-2d-3d")}
print(json.dumps(cases))`;
  const cases = JSON.parse((await exec(python, ['-c', source], { cwd: fileURLToPath(new URL('..', import.meta.url)) })).stdout);
  assert.equal(cases.articulated[1], 'segmented-cutout');
  assert.equal(cases.spline[1], 'spline-bands');
  assert.equal(cases.rigid[1], 'rigid-plane');
  assert.equal(cases.billboard[1], 'svg-billboard');
});

test('measured reconstruction selects a compact frame and exports editable semantic layers', { skip: !(python && ffmpeg) && 'needs ffmpeg and numpy' }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'style-reconstruction-'));
  const evidence = join(workspace, 'evidence');
  await mkdir(evidence);
  await makeImage(join(evidence, 'blank.png'), 'null');
  await makeImage(join(evidence, 'simple.png'), 'drawbox=x=50:y=30:w=80:h=120:color=0xd9482b:t=fill,drawbox=x=180:y=60:w=90:h=80:color=0x2fa84f:t=fill');
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180', '-frames:v', '1', '-y', join(evidence, 'complex.png')]);

  const measurement = (id, image) => ({ source: { id, title: id }, evidence: { image: `evidence/${image}`, timeSec: 1 } });
  const result = await reconstructStudy({
    workspace,
    measurements: [measurement('blank', 'blank.png'), measurement('simple', 'simple.png'), measurement('complex', 'complex.png')],
    env: { python },
  });

  assert.equal(result.available, true);
  assert.equal(result.selected.videoId, 'simple');
  assert.equal(result.representation, 'semantic-layered-2d');
  assert.ok(result.complexity.runtimeDrawCalls.value >= 3);
  assert.equal(result.complexity.regionBudgetMet, true);
  assert.ok(result.metrics.structuralSimilarity > 0.9);
  assert.ok((await stat(result.files.vectorAsset)).size < 150_000, 'vector asset stays lightweight');
  const aikiScene = JSON.parse(await readFile(result.files.aikiScene, 'utf8'));
  assert.equal(aikiScene.schema, 'aikistudio.scene-reconstruction/v1');
  assert.equal(aikiScene.quality.profile, 'standard');
  assert.equal(aikiScene.validation.supported, true);
  assert.ok(aikiScene.layers.length >= 3, 'AikiStudio receives separate editable layers, not one flattened image');
  assert.ok(aikiScene.layers.every(layer => layer.transform.rotation.every(value => value === 0)));
  assert.ok(Object.keys(aikiScene.assets).length >= aikiScene.layers.length);
  const scene = await readFile(result.files.scene, 'utf8');
  assert.match(scene, /createMeasuredScene/);
  assert.match(scene, /measured-semantic-root/);
  assert.match(scene, /editable/);
  const blueprint = JSON.parse(await readFile(result.blueprint, 'utf8'));
  assert.equal(blueprint.source.evidenceImage, 'evidence/simple.png');
  assert.equal(blueprint.representation.hybridReady, true);
  assert.equal(blueprint.candidates.length, 3);
  assert.ok(blueprint.candidates.every(candidate => candidate.regionCount <= 2500));
  assert.ok(blueprint.candidates.every(candidate => Number.isFinite(candidate.paletteEntropy)));
  assert.ok(blueprint.components.semanticLayers.some(layer => layer.role === 'subject-candidate'));
  const manifest = JSON.parse(await readFile(result.files.layerManifest, 'utf8'));
  assert.equal(manifest[0].role, 'background');
  assert.ok(manifest.length >= 3);
});

test('hybrid benchmark reconstructs separate 2D character and 3D world objects', { skip: !(python && ffmpeg) && 'needs ffmpeg and numpy' }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hybrid-reconstruction-'));
  const evidence = join(workspace, 'evidence');
  await exec(python, [benchmark, '--output-dir', evidence]);
  const truth = JSON.parse(await readFile(join(evidence, 'ground-truth.json'), 'utf8'));
  const result = await reconstructStudy({
    workspace,
    measurements: [{ source: { id: 'hybrid', title: 'Hybrid benchmark' }, evidence: { image: 'evidence/reference.png', timeSec: 0 } }],
    env: { python },
  });

  assert.equal(result.representation, 'hybrid-2d-3d');
  const blueprint = JSON.parse(await readFile(result.blueprint, 'utf8'));
  assert.equal(blueprint.components.character.representation, 'svg-billboard');
  assert.equal(blueprint.components.world.representation, 'three-primitives');
  assert.equal(blueprint.components.sun.representation, 'circle-geometry');
  assert.equal(blueprint.components.world.buildingCount, 1);
  const measuredHorizon = blueprint.components.horizonY.value / blueprint.canvas.height.value;
  assert.ok(Math.abs(measuredHorizon - truth.horizonY / truth.height) < 0.08, `horizon ${measuredHorizon}`);
  const scale = blueprint.canvas.width.value / truth.width;
  const expectedCharacter = truth.character.boundsPx.map(value => value * scale);
  assert.ok(blueprint.components.character.boundsPx.every((value, index) => Math.abs(value - expectedCharacter[index]) < 3), `character bounds ${blueprint.components.character.boundsPx}`);
  assert.ok((await stat(result.files.characterAsset)).size < 100_000);
  const aikiScene = JSON.parse(await readFile(result.files.aikiScene, 'utf8'));
  assert.equal(aikiScene.camera.projection, 'perspective');
  assert.equal(aikiScene.camera.method, 'analytic-screen-space-fit');
  assert.ok(aikiScene.layers.length > 1);
  assert.ok(aikiScene.reconstructionObjects.length >= 1);
  assert.ok(aikiScene.reconstructionObjects.every(item => item.classification === 'low-poly-3d-object' && item.selectedStrategy === 'primitive-mesh'));
  const scene = await readFile(result.files.scene, 'utf8');
  assert.match(scene, /PerspectiveCamera/);
  assert.match(scene, /BoxGeometry/);
  assert.match(scene, /measured-2d-character/);
  assert.match(scene, /measured-3d-ground/);
});

test('temporal evidence separates a moving 2D subject from a static overlapping support', { skip: !(python && ffmpeg) && 'needs ffmpeg and numpy' }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'temporal-reconstruction-'));
  const evidence = join(workspace, 'evidence');
  await exec(python, [temporalBenchmark, '--output-dir', evidence]);
  const truth = JSON.parse(await readFile(join(evidence, 'ground-truth.json'), 'utf8'));
  const temporalPath = join(evidence, 'temporal-tracks.json');
  await exec(python, [temporalTracker, join(evidence, 'temporal.mp4'), '--time', String(truth.referenceTimeSec), '--output', temporalPath]);
  const temporal = JSON.parse(await readFile(temporalPath, 'utf8'));
  assert.equal(temporal.available, true);
  assert.ok(temporal.tracks[0].persistence >= 0.8);
  assert.ok(temporal.tracks[0].displacementPx > 10);

  const result = await reconstructStudy({
    workspace,
    measurements: [{ source: { id: 'temporal', title: 'Temporal benchmark' }, evidence: { image: 'evidence/reference.png', timeSec: truth.referenceTimeSec }, temporal }],
    env: { python },
  });
  const blueprint = JSON.parse(await readFile(result.blueprint, 'utf8'));
  assert.equal(blueprint.temporal.available, true);
  assert.equal(blueprint.temporal.confirmedTracks.length, 1);
  const moving = blueprint.components.semanticLayers.find(layer => layer.role === 'character-candidate');
  assert.ok(moving, 'moving subject is promoted from a visual guess');
  assert.equal(moving.track.id, 'motion-track-1');
  assert.ok(blueprint.components.semanticLayers.some(layer => layer.role === 'static-support'));
  assert.ok((await stat(result.files.temporalTracks)).size < 100_000);
  const scene = await readFile(result.files.scene, 'utf8');
  assert.match(scene, /character-candidate/);
  assert.match(scene, /static-support/);
});

test('subject classification selects a measured strategy and embeds it in .aikiscene', { skip: !(python && ffmpeg) && 'needs ffmpeg and numpy' }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rig-reconstruction-'));
  const evidence = join(workspace, 'evidence');
  await exec(python, [temporalBenchmark, '--output-dir', evidence]);
  const truth = JSON.parse(await readFile(join(evidence, 'ground-truth.json'), 'utf8'));
  const temporalPath = join(evidence, 'temporal-tracks.json');
  await exec(python, [temporalTracker, join(evidence, 'temporal.mp4'), '--time', String(truth.referenceTimeSec), '--output', temporalPath]);
  const temporal = JSON.parse(await readFile(temporalPath, 'utf8'));
  const result = await reconstructStudy({
    workspace,
    measurements: [{ source: { id: 'rig', title: 'Rig benchmark' }, evidence: { image: 'evidence/reference.png', timeSec: truth.referenceTimeSec }, temporal }],
    env: { python },
  });
  const blueprint = JSON.parse(await readFile(result.blueprint, 'utf8'));
  assert.ok(blueprint.files.rigDefinition);
  const rig = JSON.parse(await readFile(join(workspace, 'reconstruction', blueprint.files.rigDefinition), 'utf8'));
  assert.equal(rig.animation.seekSafe, true);
  assert.ok(rig.subjects.length >= 1);
  assert.ok(rig.subjects.every(subject => ['segmented-cutout', 'spline-bands', 'rigid-plane', 'svg-billboard'].includes(subject.selectedStrategy)));
  assert.ok(rig.subjects.every(subject => Object.values(subject.features).every(value => typeof value === 'object' || Number.isFinite(value))));
  const aikiScene = await loadAikiScene(result.files.aikiScene);
  assert.equal(validateAikiScene(aikiScene).valid, true);
  assert.equal(aikiScene.subjects.length, rig.subjects.length);
  assert.equal(aikiScene.package.extension, '.aikiscene');
  assert.equal(aikiScene.package.executableCode, false);
  assert.match(aikiScene.packageDigest, /^[a-f0-9]{64}$/);
  assert.ok(aikiScene.subjects.every(subject => [...(subject.parts || []), ...(subject.bones || [])].every(record => record.assetId && !record.asset)));
  const firstDigest = aikiScene.packageDigest;
  const repacked = await embedRigInAikiScene({ scenePath: result.files.aikiScene, rigPath: join(workspace, 'reconstruction', blueprint.files.rigDefinition) });
  assert.equal(repacked.packageDigest, firstDigest, 'packing the same measured scene is deterministic');
});
