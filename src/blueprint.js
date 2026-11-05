export const BLUEPRINT_SCHEMA = 'localy.style-blueprint/v1';

export const PRESETS = {
  'stormbound-shonen': {
    name: 'Stormbound Shōnen',
    slug: 'stormbound-shonen',
    intent: 'High-clarity hand-drawn action with tactical staging, elastic impact beats and emotionally legible close-ups.',
    medium: '2D cel animation with hand-painted environments',
    lineWeight: 1.8,
    lineVariation: 42,
    texture: 28,
    saturation: 68,
    contrast: 76,
    aspectRatio: '16:9',
    frameRate: 30,
    animationStep: 2,
    focalLength: 35,
    shutterAngle: 144,
    cameraHeight: 1.35,
    horizon: 46,
    keyAngle: 38,
    keySoftness: 44,
    fillRatio: 0.32,
    rimIntensity: 62,
    palette: [
      { role: 'ink', value: '#17212b', share: 24 },
      { role: 'hero', value: '#e66a2c', share: 18 },
      { role: 'sky', value: '#70a6bb', share: 26 },
      { role: 'ground', value: '#b7a37b', share: 22 },
      { role: 'energy', value: '#d9f1ee', share: 10 },
    ],
    character: {
      silhouette: 'Triangular action silhouettes; readable hands; asymmetrical utility layers; no franchise insignia.',
      proportions: '6.75 heads tall; head 14.8% of body; shoulder width 2.35 heads; hands enlarged 8% for gesture clarity.',
      faces: 'Large dark irises, compact nose shadow, two-value skin shading, brows carry the expression.',
      costume: 'Layered cloth, wrapped joints and practical pouches; 70/20/10 colour hierarchy; one repeatable accent per character.',
    },
    environment: {
      geometry: 'Broad readable masses with one navigable foreground plane and 3–5 depth layers.',
      detail: 'Highest detail within 15° of the focal subject; background detail falls by roughly 35% per depth layer.',
      atmosphere: 'Cool aerial perspective; dust or leaves reveal motion vectors; avoid uniform particle coverage.',
    },
    motion: {
      cadence: 'Animate on twos by default; switch to ones for 6–10 frames around contact or a rapid camera move.',
      anticipationFrames: 8,
      impactFrames: 2,
      settleFrames: 10,
      smearFrames: 2,
      speedLineAngle: 18,
      parallaxRatio: 'foreground 1.00 / subject 0.55 / background 0.18',
    },
    shotMix: { wide: 24, medium: 34, close: 28, insert: 14 },
    shotGrammar: [
      { id: 'terrain-read', label: 'Terrain Read', size: 'wide', lensMm: 24, durationSec: 3.2, angleDeg: -8, move: '12% lateral drift', purpose: 'Establish combat geometry and escape routes before action.' },
      { id: 'resolve-close', label: 'Resolve Close-up', size: 'close', lensMm: 65, durationSec: 1.8, angleDeg: 0, move: '3% push-in', purpose: 'Make intention readable before the decisive move.' },
      { id: 'vector-launch', label: 'Vector Launch', size: 'medium', lensMm: 32, durationSec: 1.1, angleDeg: -14, move: '18° whip then track', purpose: 'Align the frame with the attack vector and preserve silhouette.' },
      { id: 'impact-axis', label: 'Impact Axis', size: 'insert', lensMm: 50, durationSec: 0.45, angleDeg: 6, move: '2-frame shake, 1.5% frame amplitude', purpose: 'Show contact without losing spatial direction.' },
      { id: 'aftermath-hold', label: 'Aftermath Hold', size: 'wide', lensMm: 28, durationSec: 2.4, angleDeg: 2, move: 'locked, particles continue', purpose: 'Let consequence, distance and new power balance register.' },
    ],
    continuity: [
      'Keep the screen direction of the primary action unchanged across a cut unless a neutral axis-reset shot is inserted.',
      'Preserve the hero accent colour within ΔE 6 across shots.',
      'Keep the key light within ±15° and focal length within ±10 mm inside one uninterrupted beat.',
      'Only one dominant motion vector may cross the focal subject during an impact beat.',
    ],
    avoid: [
      'Named franchise characters, costumes, insignia, villages or signature attacks',
      'Flat front lighting, plastic 3D materials, photoreal skin or uniform line weight',
      'Unmotivated Dutch angles, random speed lines, unreadable hand silhouettes or axis-breaking cuts',
      'Text, logos, watermarks, viewport guides or duplicated limbs',
    ],
  },
  'quiet-editorial': {
    name: 'Quiet Editorial', slug: 'quiet-editorial', intent: 'Measured illustrated storytelling with restrained movement and tactile print character.',
    medium: 'Editorial gouache and coloured pencil', lineWeight: 1.2, lineVariation: 22, texture: 64, saturation: 42, contrast: 48,
    aspectRatio: '16:9', frameRate: 30, animationStep: 2, focalLength: 50, shutterAngle: 180, cameraHeight: 1.55, horizon: 50,
    keyAngle: 52, keySoftness: 78, fillRatio: 0.55, rimIntensity: 12,
    palette: [
      { role: 'ink', value: '#263238', share: 18 }, { role: 'paper', value: '#eee4cf', share: 34 },
      { role: 'leaf', value: '#72836a', share: 22 }, { role: 'clay', value: '#b86f52', share: 16 }, { role: 'accent', value: '#d3a928', share: 10 },
    ],
    character: { silhouette: 'Soft geometric silhouettes with one identifying prop.', proportions: '7 heads tall; natural shoulder and hand scale.', faces: 'Minimal features with brows and head tilt doing most emotional work.', costume: 'Simple matte fabric blocks with one tactile pattern.' },
    environment: { geometry: 'Frontal stage-like planes and quiet negative space.', detail: 'Cluster detail around handled objects and faces.', atmosphere: 'Paper grain, soft edge bloom and sparse floating dust.' },
    motion: { cadence: 'Mostly held poses with 12–18 frame eases.', anticipationFrames: 12, impactFrames: 4, settleFrames: 16, smearFrames: 0, speedLineAngle: 0, parallaxRatio: 'foreground 0.55 / subject 0.32 / background 0.10' },
    shotMix: { wide: 30, medium: 42, close: 22, insert: 6 },
    shotGrammar: [
      { id: 'tableau', label: 'Editorial Tableau', size: 'wide', lensMm: 40, durationSec: 4.8, angleDeg: 0, move: '4% drift', purpose: 'State the visual argument in one readable arrangement.' },
      { id: 'human-detail', label: 'Human Detail', size: 'close', lensMm: 70, durationSec: 3.0, angleDeg: 0, move: 'locked', purpose: 'Hold on the emotional evidence without melodrama.' },
      { id: 'object-proof', label: 'Object Proof', size: 'insert', lensMm: 80, durationSec: 2.1, angleDeg: -4, move: '2% push-in', purpose: 'Let one object carry the idea.' },
    ],
    continuity: ['Preserve paper tone and grain scale.', 'Keep camera movement below 6% of frame width per shot.', 'Use one accent colour per beat.'],
    avoid: ['Glossy 3D materials', 'Fast whip pans or handheld shake', 'Dense background detail', 'Text, logos or watermarks'],
  },
};

const copy = value => JSON.parse(JSON.stringify(value));
const number = (value, fallback, min, max) => Math.min(max, Math.max(min, Number(value) || fallback));
const text = (value, fallback = '') => String(value || fallback).trim();
const list = value => Array.isArray(value) ? value.map(item => text(item)).filter(Boolean) : [];

export function normalizeBlueprint(input = {}) {
  const base = PRESETS['stormbound-shonen'];
  const source = { ...copy(base), ...copy(input) };
  const palette = (source.palette || []).slice(0, 8).map((swatch, index) => ({
    role: text(swatch.role, `colour-${index + 1}`),
    value: /^#[0-9a-f]{6}$/i.test(swatch.value) ? swatch.value.toLowerCase() : '#777777',
    share: number(swatch.share, 10, 0, 100),
  }));
  const totalShare = palette.reduce((sum, swatch) => sum + swatch.share, 0) || 1;
  palette.forEach(swatch => { swatch.share = Number((swatch.share / totalShare * 100).toFixed(1)); });
  return {
    schema: BLUEPRINT_SCHEMA,
    metadata: {
      name: text(source.name, 'Untitled style'),
      slug: text(source.slug, 'untitled-style').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      version: '1.0.0',
      intent: text(source.intent),
      generatedAt: new Date().toISOString(),
    },
    reference: normalizeReference(source.reference),
    canvas: {
      aspectRatio: ['16:9', '9:16', '1:1'].includes(source.aspectRatio) ? source.aspectRatio : '16:9',
      frameRate: number(source.frameRate, 24, 12, 60),
      animationStep: number(source.animationStep, 2, 1, 4),
      safeAreaPercent: { action: 5, title: 10 },
    },
    rendering: {
      medium: text(source.medium), lineWeightPxAt1080p: number(source.lineWeight, 1.8, 0.2, 8), lineVariationPercent: number(source.lineVariation, 40, 0, 100),
      texturePercent: number(source.texture, 25, 0, 100), saturationPercent: number(source.saturation, 60, 0, 100), contrastPercent: number(source.contrast, 60, 0, 100),
    },
    palette,
    lighting: {
      keyAngleDeg: number(source.keyAngle, 38, -180, 180), keySoftnessPercent: number(source.keySoftness, 44, 0, 100),
      fillToKeyRatio: number(source.fillRatio, 0.32, 0, 1), rimIntensityPercent: number(source.rimIntensity, 62, 0, 100),
    },
    camera: {
      defaultLensMm: number(source.focalLength, 35, 14, 200), shutterAngleDeg: number(source.shutterAngle, 180, 45, 360),
      cameraHeightM: number(source.cameraHeight, 1.35, 0.1, 12), horizonPercent: number(source.horizon, 46, 0, 100), shotMixPercent: copy(source.shotMix),
    },
    character: copy(source.character), environment: copy(source.environment), motion: copy(source.motion),
    shotGrammar: (source.shotGrammar || []).slice(0, 12).map((shot, index) => ({
      id: text(shot.id, `shot-${index + 1}`), label: text(shot.label, `Shot ${index + 1}`), size: text(shot.size, 'medium'),
      lensMm: number(shot.lensMm, 35, 14, 200), durationSec: number(shot.durationSec, 2.5, 0.2, 30), angleDeg: number(shot.angleDeg, 0, -90, 90),
      move: text(shot.move, 'locked'), purpose: text(shot.purpose),
    })),
    continuityLocks: list(source.continuity), negativeConstraints: list(source.avoid),
    promptContract: buildPromptContract(source),
    adapters: {
      polystudio: {
        aiRender: {
          style: 'custom', direction: '', strength: 'strong', modelId: 'nano-banana-pro-edit', aspectRatio: 'auto', resolution: '1K', outputFormat: 'png',
          preserve: ['camera', 'framing', 'pose', 'identity', 'outfit', 'layout'], transform: ['anatomy', 'materials', 'lighting', 'environment', 'rendering'], references: [],
        },
      },
    },
  };
}

function normalizeReference(value) {
  if (!value || typeof value !== 'object') return null;
  const source = value.source && typeof value.source === 'object' ? value.source : {};
  return {
    name: text(value.name, 'Style reference'),
    purpose: text(value.purpose, 'Primary visual reference for style, composition and finish.'),
    observations: list(value.observations).slice(0, 24),
    source: {
      ...(text(source.path) ? { path: text(source.path) } : {}),
      ...(text(source.dataUrl).startsWith('data:image/') ? { dataUrl: text(source.dataUrl) } : {}),
      ...(text(source.mimeType) ? { mimeType: text(source.mimeType) } : {}),
      ...(text(source.sha256) ? { sha256: text(source.sha256) } : {}),
      ...(Number.isFinite(source.sizeBytes) ? { sizeBytes: source.sizeBytes } : {}),
      ...(Number.isFinite(source.width) ? { width: source.width } : {}),
      ...(Number.isFinite(source.height) ? { height: source.height } : {}),
    },
  };
}

export function buildPromptContract(source) {
  const palette = (source.palette || []).map(item => `${item.role} ${item.value} (${item.share}%)`).join(', ');
  return {
    master: [
      `VISUAL INTENT: ${source.intent}`,
      `MEDIUM: ${source.medium}; ${source.lineWeight}px line at 1080p; ${source.lineVariation}% line variation; ${source.texture}% texture.`,
      `COLOUR: ${palette}. Saturation ${source.saturation}%; contrast ${source.contrast}%.`,
      `LIGHT: key ${source.keyAngle}°; softness ${source.keySoftness}%; fill:key ${source.fillRatio}; rim ${source.rimIntensity}%.`,
      `CAMERA: default ${source.focalLength}mm; ${source.cameraHeight}m height; horizon ${source.horizon}%; shutter ${source.shutterAngle}°.`,
      `CHARACTER: ${source.character?.silhouette} ${source.character?.proportions} ${source.character?.faces} ${source.character?.costume}`,
      `WORLD: ${source.environment?.geometry} ${source.environment?.detail} ${source.environment?.atmosphere}`,
      `MOTION: ${source.motion?.cadence} Anticipation ${source.motion?.anticipationFrames}f; impact ${source.motion?.impactFrames}f; settle ${source.motion?.settleFrames}f; smear ${source.motion?.smearFrames}f.`,
    ].join('\n'),
    shotTemplate: 'Use shot {{shot.id}}: {{shot.label}}. {{shot.purpose}} Frame {{shot.size}} at {{shot.lensMm}}mm, {{shot.angleDeg}}° angle, {{shot.durationSec}}s, move {{shot.move}}. Preserve all continuity locks.',
    negative: (source.avoid || []).join('; '),
  };
}

export function toPolyStudioPack(blueprint) {
  const min = Math.min(...blueprint.shotGrammar.map(shot => shot.durationSec));
  const max = Math.max(...blueprint.shotGrammar.map(shot => shot.durationSec));
  return {
    id: blueprint.metadata.slug,
    name: blueprint.metadata.name,
    version: blueprint.metadata.version,
    type: 'story-format',
    guide: 'style-guide.md',
    format: {
      id: blueprint.metadata.slug,
      label: blueprint.metadata.name,
      icon: '✦',
      blurb: blueprint.metadata.intent,
      guidance: [blueprint.promptContract.master, 'SHOT GRAMMAR', ...blueprint.shotGrammar.map(shot => `- ${shot.label}: ${shot.purpose} ${shot.size}, ${shot.lensMm}mm, ${shot.durationSec}s, angle ${shot.angleDeg}°, ${shot.move}.`), 'CONTINUITY', ...blueprint.continuityLocks.map(item => `- ${item}`)].join('\n'),
      limits: { maxShots: Math.max(12, blueprint.shotGrammar.length * 3), maxPlanShots: 120, minShot: Math.max(0.5, Number(min.toFixed(1))), maxShot: Math.min(30, Math.ceil(max + 2)) },
      beatSnap: false,
      facesCamera: false,
      fov: { close: lensToFov(Math.max(blueprint.camera.defaultLensMm, 50)), other: lensToFov(blueprint.camera.defaultLensMm) },
      videoPrompt: `${blueprint.promptContract.master}\nAVOID: ${blueprint.promptContract.negative}`,
    },
  };
}

export const lensToFov = lensMm => Number((2 * Math.atan(36 / (2 * lensMm)) * 180 / Math.PI).toFixed(1));

export function styleGuideMarkdown(blueprint) {
  const reference = blueprint.reference ? `\n## Primary reference\n\n**${blueprint.reference.name}.** ${blueprint.reference.purpose}\n\n${blueprint.reference.observations.map(item => `- ${item}`).join('\n')}\n` : '';
  return `# ${blueprint.metadata.name}\n\n${blueprint.metadata.intent}\n${reference}\n## Measured visual contract\n\n- Canvas: ${blueprint.canvas.aspectRatio}, ${blueprint.canvas.frameRate} fps, animate on ${blueprint.canvas.animationStep === 1 ? 'ones' : blueprint.canvas.animationStep === 2 ? 'twos' : `${blueprint.canvas.animationStep}s`}\n- Medium: ${blueprint.rendering.medium}\n- Default lens: ${blueprint.camera.defaultLensMm} mm; camera height: ${blueprint.camera.cameraHeightM} m; horizon: ${blueprint.camera.horizonPercent}%\n- Light: ${blueprint.lighting.keyAngleDeg}° key, ${blueprint.lighting.keySoftnessPercent}% softness, ${blueprint.lighting.fillToKeyRatio} fill:key\n\n## Shot grammar\n\n${blueprint.shotGrammar.map(shot => `- **${shot.label}:** ${shot.purpose} ${shot.size}, ${shot.lensMm} mm, ${shot.durationSec} s, ${shot.angleDeg}°, ${shot.move}.`).join('\n')}\n\n## Continuity locks\n\n${blueprint.continuityLocks.map(item => `- ${item}`).join('\n')}\n\n## Avoid\n\n${blueprint.negativeConstraints.map(item => `- ${item}`).join('\n')}\n\n## Master prompt\n\n\`\`\`text\n${blueprint.promptContract.master}\n\nAVOID: ${blueprint.promptContract.negative}\n\`\`\`\n`;
}

const xml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);

export function referenceSheetSvg(blueprint, referenceDataUrl = blueprint.reference?.source?.dataUrl || '') {
  const width = 1600, height = 1000, paletteY = 856;
  const image = referenceDataUrl.startsWith('data:image/')
    ? `<image href="${xml(referenceDataUrl)}" x="70" y="190" width="650" height="560" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect x="70" y="190" width="650" height="560" fill="#e9f0f8"/><text x="395" y="470" text-anchor="middle" font-family="DM Sans, sans-serif" font-size="24" fill="#83909d">Add one primary reference</text>`;
  const observations = (blueprint.reference?.observations || ['Reference not attached; use the measured contract at right.']).slice(0, 6);
  const shots = blueprint.shotGrammar.slice(0, 5);
  let observationY = 310, shotY = 615;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="1600" height="1000" fill="#f5f7f9"/><rect x="0" y="0" width="1600" height="100" fill="#ffffff"/><line x1="0" y1="100" x2="1600" y2="100" stroke="#dfe5eb"/>
  <text x="70" y="43" font-family="Space Grotesk, sans-serif" font-size="16" font-weight="700" letter-spacing="2" fill="#1c2834">POLY STYLE LAB</text>
  <text x="70" y="70" font-family="DM Sans, sans-serif" font-size="12" fill="#83909d">LOCALY STYLE BLUEPRINT / ${xml(blueprint.schema.split('/').at(-1).toUpperCase())}</text>
  <text x="1530" y="58" text-anchor="end" font-family="DM Sans, sans-serif" font-size="12" fill="#83909d">${xml(blueprint.canvas.aspectRatio)} · ${blueprint.canvas.frameRate} FPS · ${blueprint.camera.defaultLensMm} MM</text>
  <text x="70" y="150" font-family="Space Grotesk, sans-serif" font-size="30" font-weight="700" fill="#1c2834">${xml(blueprint.reference?.name || 'Primary style reference')}</text>
  ${image}<rect x="70" y="190" width="650" height="560" fill="none" stroke="#c9d2db"/>
  <text x="790" y="155" font-family="Space Grotesk, sans-serif" font-size="42" font-weight="700" fill="#1c2834">${xml(blueprint.metadata.name)}</text>
  <text x="790" y="198" font-family="DM Sans, sans-serif" font-size="16" fill="#6b7a89">${xml(blueprint.metadata.intent.slice(0, 100))}</text>
  <text x="790" y="258" font-family="DM Sans, sans-serif" font-size="11" font-weight="700" letter-spacing="2" fill="#c98b32">READ FROM THE REFERENCE</text>
  ${observations.map(item => { const out = `<circle cx="798" cy="${observationY - 5}" r="3" fill="#c98b32"/><text x="816" y="${observationY}" font-family="DM Sans, sans-serif" font-size="15" fill="#36485a">${xml(item.slice(0, 82))}</text>`; observationY += 36; return out; }).join('')}
  <line x1="790" y1="530" x2="1530" y2="530" stroke="#dfe5eb"/>
  <text x="790" y="575" font-family="DM Sans, sans-serif" font-size="11" font-weight="700" letter-spacing="2" fill="#c98b32">SHOT GRAMMAR</text>
  ${shots.map(shot => { const out = `<text x="790" y="${shotY}" font-family="Space Grotesk, sans-serif" font-size="16" font-weight="700" fill="#1c2834">${xml(shot.label)}</text><text x="1100" y="${shotY}" font-family="DM Mono, monospace" font-size="13" fill="#6b7a89">${xml(shot.size.toUpperCase())} · ${shot.lensMm} MM · ${shot.durationSec} S · ${shot.angleDeg}°</text>`; shotY += 42; return out; }).join('')}
  ${blueprint.palette.map((swatch, index) => { const x = 70 + blueprint.palette.slice(0, index).reduce((sum, item) => sum + item.share * 14.6, 0); return `<rect x="${x}" y="${paletteY}" width="${swatch.share * 14.6}" height="70" fill="${xml(swatch.value)}"/><text x="${x + 10}" y="${paletteY + 92}" font-family="DM Mono, monospace" font-size="11" fill="#6b7a89">${xml(swatch.role)} ${swatch.share}%</text>`; }).join('')}
  </svg>`;
}
