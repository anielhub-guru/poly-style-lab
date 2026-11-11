import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { reconstructStudy } from '../src/reconstruction.js';
import { applyCharacterChoice, embedRigInAikiScene, loadAikiScene, validateAikiScene } from '../src/aikiscene.js';

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

const root = fileURLToPath(new URL('..', import.meta.url));

test('outline smoothing rounds stair-steps, keeps border edges straight and keeps big rectangles crisp', { skip: !python && 'needs python' }, async () => {
  const source = `
import json, numpy as np
from analysis.reconstruct_frame import mask_paths, path_data
disc = np.zeros((40, 40), bool)
yy, xx = np.mgrid[:40, :40]
disc[(yy - 20) ** 2 + (xx - 20) ** 2 < 100] = True
loop = mask_paths(disc)[0]
smooth = path_data([loop], bounds=(40, 40))
edge = np.zeros((20, 20), bool); edge[:, :10] = True
box = np.zeros((40, 40), bool); box[5:30, 5:30] = True
print(json.dumps({"rawPoints": len(loop), "smooth": smooth,
  "border": path_data(mask_paths(edge), bounds=(20, 20)), "box": path_data(mask_paths(box), bounds=(40, 40))}))`;
  const out = JSON.parse((await exec(python, ['-c', source], { cwd: root })).stdout);
  const points = out.smooth.slice(1, -1).split('L').map(pair => pair.split(',').map(Number));
  // every outline point sits on the true circle (radius 10 +- 0.9, centred on pixel centres) instead of on pixel corners
  for (const [x, y] of points) assert.ok(Math.abs(Math.hypot(x - 20.5, y - 20.5) - 10) < 0.9, `${x},${y} is off the circle`);
  assert.equal(out.border, 'M0,0L10,0L10,20L0,20Z');
  assert.equal(out.box, 'M5,5L30,5L30,30L5,30Z');
});

test('ground-contact depth places lower objects nearer and exports a validated 3D world', { skip: !(python && ffmpeg) && 'needs ffmpeg and numpy' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'style-world-'));
  const image = join(dir, 'scene.png');
  // sky, grass below a horizon, two boxes standing on the grass: a small one higher up (far) and a big one lower (near)
  await makeImage(image, 'drawbox=y=100:w=320:h=80:color=0x4f9a3c:t=fill,drawbox=x=60:y=60:w=30:h=50:color=0x8a3b2b:t=fill,drawbox=x=190:y=70:w=70:h=105:color=0x2d4f9a:t=fill');
  await exec(python, [join(root, 'analysis', 'reconstruct_frame.py'), image, '--output-dir', join(dir, 'out')], { cwd: root });
  const scene = await loadAikiScene(join(dir, 'out', 'scene.aikiscene'));
  assert.equal(scene.world.method, 'ground-contact-depth');
  assert.ok(Number.isFinite(scene.camera.lensShiftNdcY));
  const standing = scene.layers.filter(layer => layer.depth?.standingOnGround);
  assert.ok(standing.length >= 2, 'both boxes stand on the ground');
  const byBottom = [...standing].sort((a, b) => (a.sourceBoundsPx[1] + a.sourceBoundsPx[3]) - (b.sourceBoundsPx[1] + b.sourceBoundsPx[3]));
  for (let i = 1; i < byBottom.length; i++) assert.ok(byBottom[i].depth.distance <= byBottom[i - 1].depth.distance, 'lower in frame means nearer');
  assert.ok(standing.every(layer => layer.thickness > 0));
  assert.ok(scene.primitives.some(item => item.kind === 'contact-shadow'));
  const broken = structuredClone(scene);
  broken.world.horizonNdc = 'high';
  assert.match(validateAikiScene(broken).errors.join(), /world measurements/);
});

test('subjects are told apart as flat sprites or shaded 3D characters and carry an AikiStudio handoff', { skip: !(python && ffmpeg) && 'needs ffmpeg and numpy' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'style-dimension-'));
  const make = `
import numpy as np, subprocess, sys
H, W = 180, 120
yy, xx = np.mgrid[:H, :W].astype(float)
def render(shaded):
    img = np.tile(np.array([170, 205, 235.]), (H, W, 1))
    for cx, cy, rx, ry, base in ((60, 120, 26, 48, (200, 90, 60)), (60, 52, 17, 19, (235, 190, 150))):
        nx, ny = (xx - cx) / rx, (yy - cy) / ry
        r2 = nx ** 2 + ny ** 2
        light = np.clip(nx * -.5 + ny * -.6 + np.sqrt(np.clip(1 - r2, 0, 1)) * .62, 0, 1)
        color = (0.25 + 0.75 * light)[..., None] * np.array(base) if shaded else np.array(base, float)
        img[r2 < 1] = np.broadcast_to(color, (H, W, 3))[r2 < 1]
    return np.clip(img, 0, 255).astype(np.uint8)
for name, shaded in (('flat', False), ('shaded', True)):
    open(f'${dir}/{name}.ppm', 'wb').write(b'P6\\n%d %d\\n255\\n' % (W, H) + render(shaded).tobytes())
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', f'${dir}/{name}.ppm', f'${dir}/{name}.png'], check=True)`;
  await exec(python, ['-c', make]);
  const classes = {};
  let shadedScene;
  for (const name of ['flat', 'shaded']) {
    await exec(python, [join(root, 'analysis', 'reconstruct_frame.py'), join(dir, `${name}.png`), '--output-dir', join(dir, name)], { cwd: root });
    const blueprint = JSON.parse(await readFile(join(dir, name, 'visual-reconstruction-blueprint.json'), 'utf8'));
    await exec(python, [join(root, 'analysis', 'rig_characters.py'), join(dir, name, 'visual-reconstruction-blueprint.json'), '--output-dir', join(dir, name, 'rig')], { cwd: root });
    await embedRigInAikiScene({ scenePath: join(dir, name, blueprint.files.aikiScene), rigPath: join(dir, name, 'rig', 'rig-definition.json') });
    const scene = await loadAikiScene(join(dir, name, blueprint.files.aikiScene));
    if (name === 'shaded') shadedScene = scene;
    classes[name] = scene.subjects.map(subject => ({ kind: subject.dimensionality.class, target: subject.handoff.target, handoff: subject.handoff }));
  }
  assert.ok(classes.flat.length >= 1 && classes.flat.every(item => item.kind === 'flat-2d-sprite' && item.target === 'aikistudio-2d-character'));
  assert.ok(classes.shaded.some(item => item.kind === 'volumetric-3d' && item.target === 'aikistudio-3d-character'));
  const three = classes.shaded.find(item => item.kind === 'volumetric-3d').handoff;
  assert.equal(three.rig, null);
  assert.equal(three.placeholder.treatment, 'extruded-cutout');
  assert.ok(three.anchor.heightMeters > 0 && three.anchor.feetPosition.every(Number.isFinite));
  assert.equal(classes.flat[0].handoff.rig.strategy.length > 0, true);

  // Pieces of one figure touch, so they are one character: one group, one primary, one shared decision.
  const groupIds = new Set(shadedScene.subjects.map(item => item.handoff.group.id));
  assert.equal(groupIds.size, 1, 'the fragments of one figure share a group');
  assert.equal(shadedScene.subjects.filter(item => item.handoff.group.primary).length, 1);
  assert.ok(shadedScene.subjects.every(item => Array.isArray(item.handoff.group.absorbedLayerIds)), 'small pieces inside the figure are listed so they can be hidden with it');
  const lone = shadedScene.subjects.find(item => !item.handoff.group.primary);
  if (lone) { applyCharacterChoice(shadedScene, lone.id, '2d'); assert.ok(shadedScene.subjects.every(item => item.handoff.choice.selected === '2d'), 'a choice on any piece applies to the whole figure'); applyCharacterChoice(shadedScene, lone.id, null); }

  // The handoff carries what the character wore: skin from the face, the torso garment from the torso band.
  const wardrobe = shadedScene.subjects.find(item => item.handoff.group.primary).handoff.reference.wardrobe;
  assert.ok(wardrobe, 'wardrobe roles are measured for the figure');
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const [skinR, skinG, skinB] = rgb(wardrobe.roles.skin), [topR, topG, topB] = rgb(wardrobe.roles.top);
  assert.ok(skinR > 180 && skinG > 140 && skinB > 100, `skin should be the light face tone, got ${wardrobe.roles.skin}`);
  assert.ok(topR > topG + 40 && topR > topB + 40, `top should be the orange-red torso, got ${wardrobe.roles.top}`);
  assert.ok(wardrobe.garments.some(item => item.category === 'top'));

  // The person decides: a choice overrides the measured class, restores or drops the 2D rig, and keeps the package valid.
  const subject = shadedScene.subjects.find(item => item.dimensionality.class === 'volumetric-3d');
  assert.deepEqual(subject.handoff.choice, { options: ['2d', '3d'], suggested: '3d', selected: null, source: 'unset' });
  applyCharacterChoice(shadedScene, subject.id, '2d');
  assert.equal(subject.handoff.target, 'aikistudio-2d-character');
  assert.ok(subject.handoff.rig, '2D choice brings the cutout rig back');
  assert.equal(subject.handoff.choice.source, 'user');
  applyCharacterChoice(shadedScene, subject.id, '3d');
  assert.equal(subject.handoff.target, 'aikistudio-3d-character');
  assert.equal(subject.handoff.rig, null);
  assert.equal(validateAikiScene(shadedScene).valid, true);
  applyCharacterChoice(shadedScene, subject.id, null);
  assert.equal(subject.handoff.choice.source, 'unset');
  assert.throws(() => applyCharacterChoice(shadedScene, subject.id, 'both'), /choice must be/);
  assert.throws(() => applyCharacterChoice(shadedScene, 'nope', '2d'), /unknown subject/);
});
