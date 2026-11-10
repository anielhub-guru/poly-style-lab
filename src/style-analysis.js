import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { rm } from 'node:fs/promises';
import { runProcess } from './process.js';
import { projectRoot } from './environment.js';
import { lensToFov } from './blueprint.js';

export const ANALYSIS_VERSION = 5;
const analyser = join(projectRoot, 'analysis', 'analyze_video.py');
const temporalTracker = join(projectRoot, 'analysis', 'track_components.py');
const GROUPS = ['head', 'shoulders', 'hands', 'torso', 'hips', 'legs'];
const fileId = id => String(id).replace(/[^a-z0-9_-]/gi, '_');

const finite = values => values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
const at = (sorted, p) => {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * p, low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
};
const round = (value, places = 3) => Number.isFinite(value) ? Number(value.toFixed(places)) : null;
/** Spread of one per-video statistic across videos. Videos with no value are left out, never counted as zero. */
export function distribution(values) {
  const sorted = finite(values);
  return { videos: sorted.length, median: round(at(sorted, .5)), p10: round(at(sorted, .1)), p90: round(at(sorted, .9)) };
}
const level = count => count >= 10 ? 'high' : count >= 5 ? 'medium' : 'low';
const exists = async path => { try { await access(path); return true; } catch { return false; } };

export async function loadCached(workspace, item, { maxSeconds, pose }) {
  try {
    const record = JSON.parse(await readFile(join(workspace, 'measurements', `${fileId(item.id)}.json`), 'utf8'));
    const fresh = record.version === ANALYSIS_VERSION && record.settings?.maxSeconds === maxSeconds && record.pose?.available === pose;
    return fresh && await exists(join(workspace, record.evidence.image)) ? record : null;
  } catch { return null; }
}

export async function analyseVideo({ item, sourcePath, normalizedPath, workspace, maxSeconds, env }) {
  const id = fileId(item.id);
  const measurementsDir = join(workspace, 'measurements'), evidenceDir = join(workspace, 'evidence');
  await mkdir(measurementsDir, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });
  const output = join(measurementsDir, `${id}.json`);
  const sheetPpm = join(evidenceDir, `${id}-look.ppm`);
  const args = [analyser, sourcePath, normalizedPath, '--output', output, '--max-sec', String(maxSeconds), '--look-sheet', sheetPpm, ...(env.pose ? [] : ['--no-pose'])];
  await runProcess(env.python, args, { timeoutMs: 600_000 });
  const measurement = JSON.parse(await readFile(output, 'utf8'));
  const evidencePath = join(evidenceDir, `${id}.jpg`);
  await runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(measurement.representativeFrame.timeSec), '-i', normalizedPath, '-frames:v', '1', '-q:v', '3', evidencePath], { timeoutMs: 60_000 });
  const lookEvidence = await lookImages({ measurement, id, evidenceDir, sheetPpm, normalizedPath, workspace });
  let temporal = { available: false, reason: 'temporal component measurement failed' };
  try {
    const temporalPath = join(measurementsDir, `${id}-temporal.json`);
    await runProcess(env.python, [temporalTracker, normalizedPath, '--time', String(measurement.representativeFrame.timeSec), '--output', temporalPath], { timeoutMs: 120_000 });
    temporal = JSON.parse(await readFile(temporalPath, 'utf8'));
  } catch { /* cadence, look and single-frame reconstruction remain valid */ }
  const record = {
    ...measurement,
    settings: { maxSeconds },
    source: { id: item.id, title: item.title, url: item.url || null, channel: item.channel || null, sourceIndex: item.sourceIndex },
    evidence: { image: relative(workspace, evidencePath), timeSec: measurement.representativeFrame.timeSec, frame: measurement.representativeFrame.frame, ...lookEvidence },
    temporal,
  };
  await writeFile(output, JSON.stringify(record));
  return record;
}


/** JPEGs a person can check: the edge sheet (frame | strong edges white, thin dark lines red) and the strongest 2D-effect moments. */
async function lookImages({ measurement, id, evidenceDir, sheetPpm, normalizedPath, workspace }) {
  const out = {};
  const look = measurement.look;
  if (!look?.available) return out;
  try {
    if (look.sheet) {
      const image = join(evidenceDir, `${id}-look.jpg`);
      await runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', sheetPpm, '-vf', 'scale=iw*1.5:ih*1.5:flags=neighbor,format=yuvj420p', '-q:v', '3', image], { timeoutMs: 60_000 });
      out.look = { image: relative(workspace, image), timeSec: look.sheet.timeSec };
    }
    const effects = [];
    for (const [index, event] of (look.effects2d?.top || []).slice(0, 2).entries()) {
      const image = join(evidenceDir, `${id}-fx${index + 1}.jpg`);
      await runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(event.timeSec), '-i', normalizedPath, '-frames:v', '1', '-vf', 'format=yuvj420p', '-q:v', '3', image], { timeoutMs: 60_000 });
      effects.push({ image: relative(workspace, image), timeSec: event.timeSec, areaShare: event.areaShare });
    }
    if (effects.length) out.effects = effects;
  } catch { /* evidence images are a convenience; the measurements stand without them */ }
  await rm(sheetPpm, { force: true });
  return out;
}

const hexRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const rgbHex = rgb => `#${rgb.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
const isHex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Fold every video's swatches into one palette (close colours merge, shares are averaged over videos and re-normalised to 100). */
export function mergePalettes(palettes, { threshold = 40, keep = 8 } = {}) {
  const clusters = [];
  for (const palette of palettes) for (const swatch of palette || []) {
    if (!isHex(swatch.hex)) continue;
    const rgb = hexRgb(swatch.hex), found = clusters.find(c => Math.hypot(...c.rgb.map((v, i) => v - rgb[i])) < threshold);
    if (found) { found.rgb = found.rgb.map((v, i) => (v * found.share + rgb[i] * swatch.share) / (found.share + swatch.share)); found.share += swatch.share; }
    else clusters.push({ rgb, share: swatch.share });
  }
  const top = clusters.sort((a, b) => b.share - a.share).slice(0, keep), total = top.reduce((sum, c) => sum + c.share, 0) || 1;
  return top.map(c => ({ hex: rgbHex(c.rgb), share: round(c.share / total * 100, 1) }));
}

const median = values => { const sorted = finite(values); return sorted.length ? at(sorted, .5) : null; };
const medianHex = hexes => { const valid = hexes.filter(isHex).map(hexRgb); return valid.length ? rgbHex([0, 1, 2].map(i => median(valid.map(c => c[i])))) : null; };

/** Plain-language verdicts from the measured numbers. Thresholds were checked against synthetic outlined, blurred and effect clips (see tests). */
export function lookVerdicts(look) {
  const m = (...path) => path.reduce((value, key) => value?.[key], look)?.median ?? null;
  const coverage = m('edges', 'outlineCoverage'), width = m('edges', 'edgeWidthPx'), bg = m('softness', 'backgroundSharpnessRatio');
  const still = m('backdrop', 'topStillness'), smooth = m('backdrop', 'smoothTopShare'), events = m('effects2d', 'eventsPer10s');
  const verdict = {
    outlines: coverage === null ? 'unknown' : coverage >= 0.8 ? 'drawn outline' : coverage >= 0.6 ? 'partial outline' : 'none',
    edges: width === null ? 'unknown' : width < 2.5 ? 'crisp' : width < 3.2 ? 'slightly soft' : 'blurry',
    background: bg === null ? 'unknown' : bg < 0.5 ? 'much softer than the subject (depth of field or a blurred plate)' : bg < 0.8 ? 'softer than the subject' : 'as sharp as the subject',
    backdrop: still === null ? 'unknown' : still >= 0.8 && (smooth ?? 0) >= 0.6 ? 'a smooth sky or plate that stays almost still while the foreground moves' : 'moves with the scene',
    effects: events === null ? 'unknown' : events >= 2 ? 'frequent' : events >= 0.5 ? 'occasional' : 'rare',
  };
  return verdict;
}

/** A starting `brief.look` for PolyStudio from the measured colours (every value inside PolyStudio's validated ranges). */
export function suggestLook(look) {
  const palette = look.palette || [], c = look.colour || {};
  const lum = hex => { const [r, g, b] = hexRgb(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
  const warm = [...palette].filter(s => lum(s.hex) > 0.5 && hexRgb(s.hex)[0] - hexRgb(s.hex)[2] > 40).sort((a, b) => (hexRgb(b.hex)[0] - hexRgb(b.hex)[2]) - (hexRgb(a.hex)[0] - hexRgb(a.hex)[2]))[0];
  const dark = [...palette].sort((a, b) => lum(a.hex) - lum(b.hex))[0];
  const out = {};
  if (isHex(c.skyTop)) out.skyTop = c.skyTop.toLowerCase();
  if (isHex(c.skyLower)) out.skyHorizon = c.skyLower.toLowerCase();
  out.sun = warm ? warm.hex : '#fff5e0';   // no warm light colour measured: a neutral warm white, not a tinted guess
  if (isHex(c.skyTop)) out.hemiSky = c.skyTop.toLowerCase();
  if (dark) out.hemiGround = dark.hex;
  const bg = look.softness?.backgroundSharpnessRatio?.median;   // PolyStudio has no depth of field: haze is the nearest stand-in for a soft background
  if (Number.isFinite(bg)) out.fog = round(clamp(0.004 + (1 - Math.min(1, bg)) * 0.014, 0.004, 0.02), 3);
  out.sunIntensity = round(clamp(2 + (c.contrast ?? 0.6) * 2, 1.5, 4.5), 1);
  out.exposure = round(clamp(1.35 - (c.brightnessMean ?? 0.5) * 0.45, 0.8, 1.3), 2);
  return out;
}

export function aggregateLook(measurements) {
  const looked = measurements.filter(item => item.look?.available);
  if (!looked.length) return null;
  const per = pick => distribution(looked.map(item => { try { return pick(item.look); } catch { return null; } }));
  const look = {
    videos: looked.length,
    palette: mergePalettes(looked.map(item => item.look.colour.palette)),
    colour: {
      saturation: per(l => l.colour.saturationMean), saturationP90: per(l => l.colour.saturationP90), brightness: per(l => l.colour.brightnessMean), contrast: per(l => l.colour.contrast),
      warmHighlightCoolShadow: per(l => l.colour.warmHighlightCoolShadow), skyGradient: per(l => l.colour.skyGradient),
      skyTop: medianHex(looked.map(item => item.look.colour.skyTop)), skyLower: medianHex(looked.map(item => item.look.colour.skyLower)),
    },
    edges: { edgeDensity: per(l => l.edges.edgeDensity), inkLineRatio: per(l => l.edges.inkLineRatio), outlineCoverage: per(l => l.edges.outlineCoverage), edgeWidthPx: per(l => l.edges.edgeWidthPx), edgeWidthPctOfFrame: per(l => l.edges.edgeWidthPctOfFrame) },
    softness: { backgroundSharpnessRatio: per(l => l.softness.backgroundSharpnessRatio), vignette: per(l => l.softness.vignette) },
    effects2d: { eventsPer10s: per(l => l.effects2d.eventsPer10s), areaShare: per(l => l.effects2d.events.areaShare.median), durationSec: per(l => l.effects2d.events.durationSec) },
    backdrop: { topStillness: per(l => l.backdrop.topStillness), smoothTopShare: per(l => l.backdrop.smoothTopShare) },
    basis: 'colour frames at 8 per second, longest side 288 px; edge widths are in those pixels; effects and backdrop are heuristics (check the evidence images)',
  };
  look.verdict = lookVerdicts(look);
  look.suggestedLook = suggestLook({ ...look, colour: { ...look.colour, contrast: look.colour.contrast.median ?? undefined, brightnessMean: look.colour.brightness.median ?? undefined } });
  return look;
}

/** Rules a director can follow, derived from the verdicts (kept short: they go into the pack guidance). */
export function lookRules(look) {
  if (!look) return [];
  const v = look.verdict, rules = [];
  rules.push(v.outlines === 'none' ? 'No outlines: separate shapes by colour and value, never with a drawn dark line.' : v.outlines === 'drawn outline' ? 'Draw a continuous dark outline around every silhouette.' : 'Use thin dark lines only on small details (brows, mouths), not around silhouettes.');
  if (v.background.startsWith('much') || v.background === 'softer than the subject') rules.push('Keep the subject sharp and the background soft (blur or haze) so the subject separates.');
  if (v.backdrop.startsWith('a smooth')) rules.push('Treat the sky as a smooth painted gradient plate behind the action.');
  if (v.effects !== 'rare') rules.push('Add soft 2D effect sprites (dust, smoke, cloud puffs) at impacts, not constant particles.');
  rules.push(`Suggested PolyStudio brief.look: ${JSON.stringify(look.suggestedLook)}`);
  return rules;
}

export function aggregateMeasurements(measurements, catalog, { skipped = [], warnings = [], maxSeconds = 45, poseAvailable = true } = {}) {
  const posed = measurements.filter(item => item.pose?.usable);
  const per = (items, pick) => items.map(item => { try { return pick(item); } catch { return null; } });
  const steps = per(measurements, item => item.cadence.animationStepNativeFrames).filter(Number.isFinite);
  const counts = new Map(); steps.forEach(step => counts.set(step, (counts.get(step) || 0) + 1));
  const mode = steps.length ? [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;

  const cadence = {
    dominantStepNativeFrames: mode,
    stepNativeFrames: distribution(steps),
    estimatedContentFps: distribution(per(measurements, item => item.cadence.estimatedContentFps)),
    imageIntervalMs: distribution(per(measurements, item => item.cadence.imageIntervalMs.median)),
    duplicateFrameRatio: distribution(per(measurements, item => item.cadence.duplicateFrameRatio)),
    holdFrames: distribution(per(measurements, item => item.cadence.holdFrames.p90)),
    nativeFps: distribution(per(measurements, item => item.nativeFps)),
  };
  const shots = {
    cutsPerMinute: distribution(per(measurements, item => item.shots.cutsPerMinute)),
    lengthSec: { typical: distribution(per(measurements, item => item.shots.lengthSec.median)), short: distribution(per(measurements, item => item.shots.lengthSec.p10)), long: distribution(per(measurements, item => item.shots.lengthSec.p90)) },
  };
  const bodyMotion = posed.length ? Object.fromEntries(GROUPS.map(group => [group, {
    speedPerSec: distribution(per(posed, item => item.bodyMotion[group].speedPerSec.median)),
    peakSpeedPerSec: distribution(per(posed, item => item.bodyMotion[group].speedPerSec.p95)),
    accelerationPerSec2: distribution(per(posed, item => item.bodyMotion[group].accelerationPerSec2.median)),
  }])) : null;
  const talking = posed.filter(item => item.coSpeech);
  const coSpeechMotion = talking.length ? {
    mouthHeadCorrelation: distribution(per(talking, item => item.coSpeech.mouthHeadCorrelation)),
    mouthShoulderCorrelation: distribution(per(talking, item => item.coSpeech.mouthShoulderCorrelation)),
    mouthHandCorrelation: distribution(per(talking, item => item.coSpeech.mouthHandCorrelation)),
    headSpeedRatioActiveOverQuiet: distribution(per(talking, item => item.coSpeech.headSpeedMouthActive.median / item.coSpeech.headSpeedMouthQuiet.median)),
  } : null;

  const moving = measurements.filter(item => item.motion);
  const motion = moving.length ? {
    regionShare: Object.fromEntries(['top', 'middle', 'bottom', 'left', 'center', 'right'].map(key => [key, distribution(per(moving, item => item.motion.regionShare[key]))])),
    activeAreaRatio: distribution(per(moving, item => item.motion.activeAreaRatio.median)),
    energyPerSec: distribution(per(moving, item => item.motion.energyPerSec.median)),
    burstiness: distribution(per(moving, item => item.motion.burstiness)),
    accentsPer10s: distribution(per(moving, item => item.motion.accents.per10s)),
  } : null;
  const measuredPatterns = {
    cadence, shots, motion, motionEnergy: distribution(per(measurements, item => item.motionEnergy.median)),
    bodyMotion, coSpeechMotion, snapEventsPer10s: posed.length ? distribution(per(posed, item => item.snapEvents.per10s)) : null,
  };
  const trackedRatios = measurements.filter(item => item.pose?.available).map(item => item.pose.trackedFrameRatio);
  const confidence = {
    analysedVideos: measurements.length, poseUsableVideos: posed.length,
    meanPoseTrackedFrameRatio: trackedRatios.length ? round(trackedRatios.reduce((a, b) => a + b, 0) / trackedRatios.length, 3) : 0,
    cadence: level(measurements.length), movement: level(moving.length), bodyMotion: poseAvailable ? level(posed.length) : 'unavailable',
    basis: 'native-rate cadence + 30fps landmark motion in shoulder-widths per second',
  };
  const allWarnings = [...warnings, ...(catalog.warnings || [])];
  if (poseAvailable && measurements.length > posed.length) allWarnings.push(`${measurements.length - posed.length} of ${measurements.length} videos had too little pose tracking (stylised or small figures); they count for cadence and cutting only.`);

  const look = aggregateLook(measurements);
  if (!look && measurements.length) allWarnings.push('Colour, edge and 2D-effect measurements were not available for these videos.');
  const blueprint = {
    schema: 'polystudio.motion-style-blueprint/v1', analysisVersion: ANALYSIS_VERSION, generatedAt: new Date().toISOString(),
    analysisClock: { fps: 30, constantFrameRate: true, cadenceMeasuredAt: 'native frame rate' },
    sourceStudy: { kind: catalog.kind, source: catalog.source, available: catalog.available, eligible: catalog.eligible, analysedVideos: measurements.length, skippedVideos: skipped.length, secondsPerVideo: maxSeconds, selection: 'evenly spaced across the newest listed videos' },
    measuredPatterns: { ...measuredPatterns, look }, confidence, warnings: allWarnings, skipped,
    videos: measurements.map(item => ({ id: item.source.id, title: item.source.title, url: item.source.url, nativeFps: item.nativeFps, analysedSec: item.analysedSec, step: item.cadence.animationStepNativeFrames, cuts: item.shots.cuts, poseUsable: item.pose.usable, poseTrackedFrameRatio: item.pose.trackedFrameRatio ?? null, evidence: item.evidence, effects: item.look?.available ? item.look.effects2d.events.count : null })),
  };
  blueprint.summary = summaryLines(blueprint);
  return blueprint;
}

const num = (value, places = 2) => Number.isFinite(value) ? String(round(value, places)) : '?';

export function summaryLines(blueprint) {
  const { cadence, shots, motion, bodyMotion, coSpeechMotion, snapEventsPer10s } = blueprint.measuredPatterns;
  const lines = [];
  const step = cadence.dominantStepNativeFrames;
  lines.push(`Cadence: ${step ? `pictures change every ${step} native frame(s)` : 'step not determined'} (~${num(cadence.estimatedContentFps.median, 1)} drawings/s at ${num(cadence.nativeFps.median, 0)} fps source); ${num(cadence.duplicateFrameRatio.median * 100, 0)}% of frames repeat the previous picture; holds up to ${num(cadence.holdFrames.median, 0)} frames.`);
  lines.push(`Editing: a cut every ${num(shots.lengthSec.typical.median, 1)}s typically (short ${num(shots.lengthSec.short.median, 1)}s, long ${num(shots.lengthSec.long.median, 1)}s); ${num(shots.cutsPerMinute.median, 1)} cuts/min.`);
  if (motion) {
    const pct = value => num(value * 100, 0), share = motion.regionShare, area = motion.activeAreaRatio.median, burst = motion.burstiness.median;
    const spread = area < 0.05 ? 'localized (limited animation)' : area < 0.2 ? 'moderate' : 'full-frame';
    const feel = burst > 2.5 ? 'punchy' : burst < 1.5 ? 'steady' : 'varied';
    lines.push(`Movement: ${pct(share.top.median)}% top / ${pct(share.middle.median)}% middle / ${pct(share.bottom.median)}% bottom third; ${spread} (~${num(area * 100, 1)}% of the frame changes at once); ${feel} (peak/typical ${num(burst, 1)}); ~${num(motion.accentsPer10s.median, 1)} accents per 10s.`);
  }
  if (bodyMotion) {
    lines.push(`Body speed (shoulder-widths/s, median / peak): ${GROUPS.map(group => `${group} ${num(bodyMotion[group].speedPerSec.median)}/${num(bodyMotion[group].peakSpeedPerSec.median)}`).join('; ')}.`);
    if (snapEventsPer10s) lines.push(`Accents: ~${num(snapEventsPer10s.median, 1)} sharp snap moments per 10s.`);
  }
  const look = blueprint.measuredPatterns.look;
  if (look) {
    const c = look.colour, e = look.edges, sft = look.softness, fx = look.effects2d, v = look.verdict, pct = x => num(x * 100, 0);
    lines.push(`Colour: saturation ${pct(c.saturation.median)}% (peak ${pct(c.saturationP90.median)}%), contrast ${pct(c.contrast.median)}%; sky ${c.skyTop || '?'} at the top to ${c.skyLower || '?'} lower; highlights ${c.warmHighlightCoolShadow.median > 0.03 ? 'warmer' : c.warmHighlightCoolShadow.median < -0.03 ? 'cooler' : 'about as warm'} than shadows; palette ${look.palette.slice(0, 5).map(s => s.hex).join(' ')}.`);
    lines.push(`Edges: outlines ${v.outlines} (${pct(e.outlineCoverage.median)}% of strong edges sit on a dark line); edges ${v.edges} (~${num(e.edgeWidthPx.median, 1)}px at 288px); background ${v.background} (${num(sft.backgroundSharpnessRatio.median, 2)}x the subject's sharpness); backdrop ${v.backdrop}.`);
    lines.push(`2D effects: ${v.effects} (~${num(fx.eventsPer10s.median, 1)} soft smoke/cloud/dust-like events per 10s, ~${pct(fx.areaShare.median)}% of the frame, ~${num(fx.durationSec.median, 1)}s each); heuristic, see the effect evidence frames.`);
  }
  if (coSpeechMotion) lines.push(`Speech: head moves ${num(coSpeechMotion.headSpeedRatioActiveOverQuiet.median, 1)}x faster while the mouth is open than closed; mouth-head correlation ${num(coSpeechMotion.mouthHeadCorrelation.median)}.`);
  const { confidence: c } = blueprint;
  lines.push(`Confidence: ${c.analysedVideos} videos (cadence ${c.cadence}); ${c.poseUsableVideos} with usable pose (body motion ${c.bodyMotion}).`);
  return lines;
}

/** A PolyStudio story-format pack whose guidance carries the measured motion rules. */
export function toMotionPack(blueprint, { name = 'Measured motion style' } = {}) {
  const slug = `motion-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'study'}`;
  const { shots } = blueprint.measuredPatterns;
  const minShot = Math.max(0.5, round(shots.lengthSec.short.median ?? 1, 1)), maxShot = Math.min(30, Math.ceil((shots.lengthSec.long.median ?? 8) + 1));
  const guidance = ['MEASURED MOTION AND LOOK RULES (from real videos; follow the numbers, not adjectives)', ...blueprint.summary.map(line => `- ${line}`), ...(blueprint.measuredPatterns.look ? ['LOOK DIRECTION', ...lookRules(blueprint.measuredPatterns.look).map(line => `- ${line}`)] : [])].join('\n');
  return {
    id: slug, name, version: '1.0.0', type: 'story-format', guide: 'style-guide.md',
    format: {
      id: slug, label: name, icon: '✦', blurb: `Motion measured from ${blueprint.confidence.analysedVideos} short videos.`, guidance,
      limits: { maxShots: 24, maxPlanShots: 120, minShot, maxShot: Math.max(maxShot, minShot + 1) },
      beatSnap: false, facesCamera: false, fov: { close: lensToFov(50), other: lensToFov(35) }, videoPrompt: guidance,
    },
  };
}

export const styleGuideFromStudy = (blueprint, name) => `# ${name}\n\n${blueprint.summary.map(line => `- ${line}`).join('\n')}\n\n${blueprint.warnings.length ? `## Warnings\n\n${blueprint.warnings.map(line => `- ${line}`).join('\n')}\n\n` : ''}Source: ${blueprint.sourceStudy.source} (${blueprint.sourceStudy.analysedVideos} videos, first ${blueprint.sourceStudy.secondsPerVideo}s of each).\n`;

export async function writeStudy(workspace, blueprint, name) {
  const output = join(workspace, 'motion-style-blueprint.json');
  await writeFile(output, `${JSON.stringify(blueprint, null, 1)}\n`);
  await writeFile(join(workspace, 'summary.md'), styleGuideFromStudy(blueprint, name));
  const packDir = join(workspace, 'pack');
  await mkdir(packDir, { recursive: true });
  await writeFile(join(packDir, 'pack.json'), `${JSON.stringify(toMotionPack(blueprint, { name }), null, 2)}\n`);
  await writeFile(join(packDir, 'style-guide.md'), styleGuideFromStudy(blueprint, name));
  return { output, summary: join(workspace, 'summary.md'), packDir };
}
