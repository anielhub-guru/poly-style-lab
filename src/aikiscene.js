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
  if (scene?.world) {
    const numbers = [scene.world.horizonNdc, scene.world.cameraHeight, scene.world.nearDistance, scene.world.wallDistance, scene.world.ground?.y, scene.world.wall?.z, scene.camera?.lensShiftNdcY];
    if (numbers.some(value => !Number.isFinite(value))) errors.push('world measurements must be finite numbers');
    for (const key of ['ground', 'wall']) if (!scene.assets?.[scene.world[key]?.assetId]) errors.push(`world.${key} references a missing asset`);
  }
  for (const layer of scene?.layers || []) {
    if (!Number.isFinite(layer.thickness) || layer.thickness < 0) errors.push(`invalid layer thickness: ${layer.id}`);
  }
  for (const subject of scene?.subjects || []) {
    if (!subject.id || !subject.classification || !subject.selectedStrategy) errors.push('subject classification is incomplete');
    if (subject.dimensionality && !['flat-2d-sprite', 'volumetric-3d', 'uncertain'].includes(subject.dimensionality.class)) errors.push(`unknown dimensionality: ${subject.id}`);
    if (![undefined, null, '2d', '3d'].includes(subject.handoff?.choice?.selected)) errors.push(`invalid character choice: ${subject.id}`);
    if (subject.handoff && !['aikistudio-2d-character', 'aikistudio-3d-character', 'needs-choice'].includes(subject.handoff.target)) errors.push(`unknown handoff target: ${subject.id}`);
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

const handoffTargets = { 'volumetric-3d': 'aikistudio-3d-character', 'flat-2d-sprite': 'aikistudio-2d-character', uncertain: 'needs-choice' };
const userChoices = { '2d': 'aikistudio-2d-character', '3d': 'aikistudio-3d-character' };

/**
 * The handshake: what AikiStudio needs to route a recovered subject into its own character tools.
 * Style Lab measures and classifies; AikiStudio owns character creation, rigging and animation.
 */
export function characterHandoff(scene, subject, selected = null, resolved = {}) {
  const layer = scene.layers.find(item => item.id === subject.sourceLayer);
  const kind = resolved.kind || subject.dimensionality?.class || 'uncertain';
  const [width, height] = resolved.size || layer?.size || [1, 1];
  const [x, y, z] = resolved.centre || layer?.transform?.position || [0, 0, 0];
  const standing = Boolean(layer?.depth?.standingOnGround);
  const bounds = subject.boundsPx;
  return {
    version: 'aikistudio.character-handoff/v1',
    target: selected ? userChoices[selected] : handoffTargets[kind], defaultTarget: 'aikistudio-2d-character',
    // The measurement is a hint; the person decides. `selected` ('2d' | '3d') always wins over the measured class.
    choice: { options: ['2d', '3d'], suggested: kind === 'volumetric-3d' ? '3d' : kind === 'flat-2d-sprite' ? '2d' : null, selected, source: selected ? 'user' : 'unset' },
    dimensionality: kind, confidence: subject.dimensionality?.confidence ?? 0,
    ...(resolved.group ? { group: resolved.group } : {}),
    placeholder: { layerId: layer?.id ?? null, assetId: layer?.assetId ?? null, treatment: 'extruded-cutout', replaceWhenCharacterExists: true },
    anchor: {
      feetPosition: [x, standing && scene.world ? scene.world.ground.y : y - height / 2, z],
      heightMeters: height, widthMeters: width, standingOnGround: standing,
      distanceFromCamera: layer?.depth?.distance ?? null, facing: 'camera',
    },
    reference: {
      assetId: layer?.assetId ?? null, boundsPx: bounds, paletteHex: subject.paletteHex || [],
      proportions: { aspectRatio: subject.features?.aspectRatio, elongation: subject.features?.elongation },
      lightDirection2d: subject.dimensionality?.evidence?.lightDirection2d ?? null,
    },
    rig: (selected ? selected === '3d' : kind === 'volumetric-3d') ? null : {
      strategy: subject.selectedStrategy, partIds: (subject.parts || subject.bones || []).map(item => item.id), supportedMotion: subject.supportedMotion,
    },
    notes: (selected ? selected === '3d' : kind === 'volumetric-3d')
      ? ['Hidden sides are not recovered; build the character in AikiStudio from the reference and proportions.']
      : !selected && kind === 'uncertain' ? ['Evidence is ambiguous; ask the user and default to the 2D sprite.'] : [],
  };
}

const boundsGap = (a, b) => Math.max(0, a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3]);

/**
 * One drawn or rendered figure is often cut into several adjacent layers. Subjects whose bounds touch are one
 * character: they share a decision, and the largest piece carries the anchor of the whole union.
 */
export function groupSubjects(subjects, gapPx = 2) {
  const parent = subjects.map((_, index) => index);
  const find = index => parent[index] === index ? index : (parent[index] = find(parent[index]));
  subjects.forEach((a, i) => subjects.forEach((b, j) => { if (j > i && boundsGap(a.boundsPx, b.boundsPx) <= gapPx) parent[find(j)] = find(i); }));
  const groups = new Map();
  subjects.forEach((subject, index) => { const key = find(index); groups.set(key, [...(groups.get(key) || []), subject]); });
  return [...groups.values()];
}

/** (Re)build every subject's handoff, grouping touching fragments into one character. `choices` maps subject id to '2d' | '3d'. */
export function buildHandoffs(scene, choices = new Map()) {
  const area = subject => (subject.boundsPx[2] - subject.boundsPx[0]) * (subject.boundsPx[3] - subject.boundsPx[1]);
  groupSubjects(scene.subjects || []).forEach((members, index) => {
    const leader = [...members].sort((a, b) => (b.dimensionality?.volumeScore ?? -1) - (a.dimensionality?.volumeScore ?? -1))[0];
    const primary = [...members].sort((a, b) => area(b) - area(a))[0];
    const selected = members.map(member => choices.get(member.id)).find(Boolean) ?? null;
    const kind = leader.dimensionality?.class || 'uncertain';
    const layers = members.map(member => scene.layers.find(item => item.id === member.sourceLayer)).filter(Boolean);
    const boxes = layers.map(layer => ({ left: layer.transform.position[0] - layer.size[0] / 2, right: layer.transform.position[0] + layer.size[0] / 2, bottom: layer.transform.position[1] - layer.size[1] / 2, top: layer.transform.position[1] + layer.size[1] / 2 }));
    const union = boxes.length ? { left: Math.min(...boxes.map(b => b.left)), right: Math.max(...boxes.map(b => b.right)), bottom: Math.min(...boxes.map(b => b.bottom)), top: Math.max(...boxes.map(b => b.top)) } : null;
    const primaryLayer = scene.layers.find(item => item.id === primary.sourceLayer);
    // Small unclassified pieces touching the figure (a head, a hand) belong to it; larger layers are scenery.
    const memberLayerIds = new Set(members.map(member => member.sourceLayer));
    const ownedBySubjects = new Set(scene.subjects.map(item => item.sourceLayer));
    const unionPx = [Math.min(...members.map(m => m.boundsPx[0])), Math.min(...members.map(m => m.boundsPx[1])), Math.max(...members.map(m => m.boundsPx[2])), Math.max(...members.map(m => m.boundsPx[3]))];
    const unionArea = (unionPx[2] - unionPx[0]) * (unionPx[3] - unionPx[1]);
    const absorbed = scene.layers.filter(layer => {
      if (memberLayerIds.has(layer.id) || ownedBySubjects.has(layer.id) || layer.role !== 'foreground-detail' || !layer.sourceBoundsPx) return false;   // never props, scenery or the backdrop
      const [x, y, w, h] = layer.sourceBoundsPx;
      return w * h <= unionArea * .6 && boundsGap([x, y, x + w, y + h], unionPx) <= 2;
    }).map(layer => layer.id);
    for (const member of members) {
      const isPrimary = member === primary, group = { id: `character-group-${index + 1}`, memberIds: members.map(item => item.id), primary: isPrimary };
      const resolved = { kind, group: { ...group, absorbedLayerIds: absorbed } };
      if (isPrimary && union && members.length > 1) {
        resolved.size = [union.right - union.left, union.top - union.bottom];
        resolved.centre = [(union.left + union.right) / 2, (union.top + union.bottom) / 2, primaryLayer?.transform?.position?.[2] ?? 0];
      }
      member.handoff = characterHandoff(scene, member, selected, resolved);
    }
  });
}

function sceneEntities(scene, subjects) {
  const subjectLayerIds = new Set(subjects.map(subject => subject.sourceLayer));
  const entities = subjects.map((subject, index) => {
    const source = scene.layers.find(layer => layer.id === subject.sourceLayer);
    return {
      id: `entity-${subject.id}`, name: index === 0 ? 'Recovered character' : 'Recovered creature',
      kind: subject.selectedStrategy === 'spline-bands' ? 'creature' : 'actor', strategy: subject.selectedStrategy,
      sourceLayerIds: [subject.sourceLayer], size: source?.size || [1, 1], transform: source?.transform,
      confidence: subject.classificationConfidence, motion: subject.motion,
      parts: assetRecords(subject).map(record => ({ id: record.id, assetId: record.assetId, pivotNormalized: record.pivotNormalized, layerOrder: record.layerOrder })),
    };
  });
  const supports = scene.layers.filter(layer => layer.role === 'static-support');
  for (const [index, support] of supports.entries()) {
    const [sx, sy, sw, sh] = support.sourceBoundsPx;
    const candidates = scene.layers.filter(layer => {
      if (subjectLayerIds.has(layer.id) || layer.role === 'background' || layer.role === 'environment-region') return false;
      const [x, y, w, h] = layer.sourceBoundsPx;
      const cx = x + w / 2, cy = y + h / 2;
      return layer.id === support.id || (cx >= sx - sw * 2 && cx <= sx + sw * 3 && cy >= sy - sh * 2 && cy <= sy + sh && ['repeated-prop', 'prop-candidate'].includes(layer.role));
    });
    if (candidates.length < 2) continue;
    entities.push({
      id: `entity-prop-${index + 1}`, name: `Recovered prop ${index + 1}`, kind: 'prop', strategy: 'layer-group',
      sourceLayerIds: candidates.map(layer => layer.id), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      confidence: Math.min(...candidates.map(layer => layer.confidence || .5)),
      parts: candidates.map(layer => ({ id: layer.id, assetId: layer.assetId, size: layer.size, position: layer.transform.position, layerOrder: layer.depthOrder || 0 })),
    });
  }
  return entities;
}

/** Record the user's 2D/3D decision for one subject; rebuilds its handoff and the package digest. */
export function applyCharacterChoice(scene, subjectId, choice) {
  if (choice !== null && !(choice in userChoices)) throw new Error(`choice must be '2d', '3d' or null, got ${choice}`);
  const subject = scene.subjects?.find(item => item.id === subjectId);
  if (!subject) throw new Error(`unknown subject: ${subjectId}`);
  const choices = new Map(scene.subjects.map(item => [item.id, item.handoff?.choice?.selected]));
  for (const id of subject.handoff?.group?.memberIds || [subject.id]) choices.set(id, choice);   // a figure cut into pieces shares one decision
  buildHandoffs(scene, choices);
  scene.packageDigest = digest(scene);
  const validation = validateAikiScene(scene);
  if (!validation.valid) throw new Error(`Invalid .aikiscene after choice: ${validation.errors.join('; ')}`);
  return scene;
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
  const previous = new Map((scene.subjects || []).map(item => [item.id, item.handoff?.choice?.selected]));
  scene.subjects = subjects;
  buildHandoffs(scene, new Map([...previous].filter(([, value]) => value)));
  scene.reconstructionObjects = structuredClone(rig.objects || []);
  scene.reconstructionStrategy = rig.sceneStrategy;
  scene.rigs = subjects.map(subject => ({
    id: `rig-${subject.id}`, subjectId: subject.id, type: subject.selectedStrategy,
    parts: (subject.parts || subject.bones || []).map(record => record.id),
  }));
  scene.entities = sceneEntities(scene, subjects);
  scene.animations = [{ id: 'measured-new-pose', ...rig.animation }];
  scene.package = { format: 'single-json', extension: '.aikiscene', executableCode: false, remoteAssets: false };
  scene.packageDigest = digest(scene);
  const validation = validateAikiScene(scene);
  if (!validation.valid) throw new Error(`Packed .aikiscene failed validation: ${validation.errors.join('; ')}`);
  await writeFile(outputPath, `${JSON.stringify(scene, null, 2)}\n`);
  return scene;
}
