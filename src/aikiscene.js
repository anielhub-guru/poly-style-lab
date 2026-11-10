import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

const schema = 'aikistudio.scene-reconstruction/v1';
const unsafeSvg = /<\s*(script|foreignObject|iframe|object|embed|animate|set)\b|\bon[a-z]+\s*=|(?:href|src)\s*=\s*["'](?:https?:|data:text\/html|javascript:)/i;

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(scene) {
  const copy = structuredClone(scene);
  delete copy.packageDigest;
  return createHash('sha256').update(stable(copy)).digest('hex');
}

export function validateAikiScene(scene) {
  const errors = [];
  if (scene?.schema !== schema) errors.push(`unsupported schema: ${scene?.schema}`);
  if (!Array.isArray(scene?.layers)) errors.push('layers must be an array');
  if (!scene?.assets || typeof scene.assets !== 'object') errors.push('assets must be an object');
  for (const [id, asset] of Object.entries(scene?.assets || {})) {
    if (asset.mediaType !== 'image/svg+xml' || typeof asset.content !== 'string') errors.push(`invalid asset: ${id}`);
    else if (unsafeSvg.test(asset.content)) errors.push(`unsafe SVG asset: ${id}`);
  }
  for (const subject of scene?.subjects || []) {
    if (!subject.id || !subject.classification || !subject.selectedStrategy) errors.push('subject classification is incomplete');
    const numbers = [...(subject.boundsPx || []), subject.classificationConfidence];
    if (numbers.some(value => !Number.isFinite(value))) errors.push(`non-finite subject measurement: ${subject.id}`);
  }
  if (scene?.packageDigest && scene.packageDigest !== digest(scene)) errors.push('package digest mismatch');
  return { valid: errors.length === 0, errors };
}

export async function loadAikiScene(path) {
  const scene = JSON.parse(await readFile(path, 'utf8'));
  const validation = validateAikiScene(scene);
  if (!validation.valid) throw new Error(`Invalid .aikiscene: ${validation.errors.join('; ')}`);
  return scene;
}

function assetRecords(subject) {
  return [...(subject.parts || []), ...(subject.bones || [])];
}

export async function embedRigInAikiScene({ scenePath, rigPath, outputPath = scenePath }) {
  const scene = JSON.parse(await readFile(scenePath, 'utf8'));
  const initialValidation = validateAikiScene(scene);
  if (!initialValidation.valid) throw new Error(`Cannot extend invalid .aikiscene: ${initialValidation.errors.join('; ')}`);
  const rig = JSON.parse(await readFile(rigPath, 'utf8'));
  const rigRoot = resolve(dirname(rigPath));
  const subjects = structuredClone(rig.subjects || []);
  for (const id of Object.keys(scene.assets)) if (id.startsWith('rig-')) delete scene.assets[id];
  for (const subject of subjects) {
    for (const record of assetRecords(subject)) {
      const assetPath = resolve(rigRoot, record.asset);
      if (!assetPath.startsWith(`${rigRoot}${sep}`)) throw new Error(`Rig asset escapes package root: ${record.asset}`);
      const content = await readFile(assetPath, 'utf8');
      if (unsafeSvg.test(content)) throw new Error(`Unsafe rig SVG: ${record.asset}`);
      const assetId = `rig-${subject.id}-${record.id}`;
      scene.assets[assetId] = { mediaType: 'image/svg+xml', encoding: 'utf8', content };
      delete record.asset;
      record.assetId = assetId;
    }
  }
  scene.subjects = subjects;
  scene.reconstructionObjects = structuredClone(rig.objects || []);
  scene.reconstructionStrategy = rig.sceneStrategy;
  scene.rigs = subjects.map(subject => ({
    id: `rig-${subject.id}`, subjectId: subject.id, type: subject.selectedStrategy,
    parts: (subject.parts || subject.bones || []).map(record => record.id),
  }));
  scene.animations = [{ id: 'measured-new-pose', ...rig.animation }];
  scene.package = { format: 'single-json', extension: '.aikiscene', executableCode: false, remoteAssets: false };
  scene.packageDigest = digest(scene);
  const validation = validateAikiScene(scene);
  if (!validation.valid) throw new Error(`Packed .aikiscene failed validation: ${validation.errors.join('; ')}`);
  await writeFile(outputPath, `${JSON.stringify(scene, null, 2)}\n`);
  return scene;
}
