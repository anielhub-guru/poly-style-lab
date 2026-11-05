import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { PRESETS, normalizeBlueprint, referenceSheetSvg, styleGuideMarkdown, toPolyStudioPack } from './blueprint.js';
import { catalogSource } from './source-catalog.js';
import { ingestCatalog, normalizeVideo } from './video-ingest.js';
import { aggregateMeasurements, analyseVideo, writeStudy } from './style-analysis.js';

const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
const required = (value, name) => { if (!value || typeof value !== 'string') throw new Error(`${name} is required`); return value; };
const readJson = async file => JSON.parse(await readFile(resolve(file), 'utf8'));
const writeJson = async (file, value) => { const target = resolve(file); await mkdir(dirname(target), { recursive: true }); await writeFile(target, `${JSON.stringify(value, null, 2)}\n`); return target; };
const inspect = blueprint => ({ schema: blueprint.schema, name: blueprint.metadata.name, slug: blueprint.metadata.slug, reference: blueprint.reference ? { name: blueprint.reference.name, observations: blueprint.reference.observations.length, source: blueprint.reference.source.path || 'embedded' } : null, shots: blueprint.shotGrammar.length, continuityLocks: blueprint.continuityLocks.length, exclusions: blueprint.negativeConstraints.length, canvas: blueprint.canvas, camera: blueprint.camera });

export const TOOL_DEFINITIONS = [
  { name: 'style_analyze_channel', description: 'Download 10–20 videos from a YouTube channel or playlist, analyse every frame on a normalized 30 FPS clock, and create a measured PolyStudio motion-style blueprint.', inputSchema: { type: 'object', required: ['source', 'outputDir'], properties: { source: { type: 'string', description: 'YouTube channel, playlist, video URL, local video, or local folder.' }, outputDir: { type: 'string' }, videoCount: { type: 'integer', minimum: 10, maximum: 20, default: 15 } }, additionalProperties: false } },
  { name: 'style_list_presets', description: 'List built-in style systems available as measured starting points.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, readOnlyHint: true },
  { name: 'style_create', description: 'Create a normalized Localy style blueprint JSON file from a preset.', inputSchema: { type: 'object', required: ['output'], properties: { output: { type: 'string' }, preset: { type: 'string' }, name: { type: 'string' }, intent: { type: 'string' } }, additionalProperties: false } },
  { name: 'style_inspect', description: 'Return a compact machine-readable summary of a blueprint.', inputSchema: { type: 'object', required: ['blueprint'], properties: { blueprint: { type: 'string' } }, additionalProperties: false }, readOnlyHint: true },
  { name: 'style_validate', description: 'Validate and normalize a blueprint, returning actionable completeness checks.', inputSchema: { type: 'object', required: ['blueprint'], properties: { blueprint: { type: 'string' } }, additionalProperties: false }, readOnlyHint: true },
  { name: 'style_attach_reference', description: 'Copy exactly one primary reference image beside a blueprint and record its hash, purpose and observations.', inputSchema: { type: 'object', required: ['blueprint', 'image'], properties: { blueprint: { type: 'string' }, image: { type: 'string' }, name: { type: 'string' }, purpose: { type: 'string' }, observations: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } },
  { name: 'style_compile_prompt', description: 'Compile the master prompt or one named shot prompt from a blueprint.', inputSchema: { type: 'object', required: ['blueprint'], properties: { blueprint: { type: 'string' }, shotId: { type: 'string' } }, additionalProperties: false }, readOnlyHint: true },
  { name: 'style_export_pack', description: 'Export a PolyStudio-compatible story-format pack.json and style-guide.md.', inputSchema: { type: 'object', required: ['blueprint', 'outputDir'], properties: { blueprint: { type: 'string' }, outputDir: { type: 'string' } }, additionalProperties: false } },
  { name: 'style_reference_sheet', description: 'Generate a single SVG contact sheet showing the primary reference and measured blueprint.', inputSchema: { type: 'object', required: ['blueprint', 'output'], properties: { blueprint: { type: 'string' }, output: { type: 'string' } }, additionalProperties: false } },
];

export async function runCommand(name, input = {}) {
  if (name === 'style_analyze_channel') {
    const source = required(input.source, 'source');
    const workspace = resolve(required(input.outputDir, 'outputDir'));
    await mkdir(workspace, { recursive: true });
    const progress = [];
    const onProgress = event => progress.push({ ...event, at: new Date().toISOString() });
    const catalog = await catalogSource(source, input.videoCount || 15);
    const ingested = await ingestCatalog(catalog, workspace, onProgress);
    const measurements = [];
    for (const item of ingested) {
      const normalized = await normalizeVideo(item, workspace, onProgress);
      measurements.push(await analyseVideo(normalized, workspace, onProgress));
    }
    const blueprint = aggregateMeasurements(measurements, catalog);
    const output = await writeStudy(workspace, blueprint);
    return { output, workspace, analysisFps: 30, videosAnalysed: measurements.length, evidence: blueprint.evidence[0] || null, evidenceFrame: blueprint.evidence[0]?.representativeFrame || null, confidence: blueprint.confidence, progress };
  }
  if (name === 'style_list_presets') return Object.entries(PRESETS).map(([id, preset]) => ({ id, name: preset.name, intent: preset.intent, shots: preset.shotGrammar.length }));
  if (name === 'style_create') {
    const presetId = input.preset || 'stormbound-shonen', preset = PRESETS[presetId];
    if (!preset) throw new Error(`Unknown preset: ${presetId}. Use style_list_presets.`);
    const blueprint = normalizeBlueprint({ ...preset, ...(input.name ? { name: input.name, slug: input.name } : {}), ...(input.intent ? { intent: input.intent } : {}) });
    const path = await writeJson(required(input.output, 'output'), blueprint);
    return { created: path, blueprint: inspect(blueprint) };
  }
  const blueprintPath = resolve(required(input.blueprint, 'blueprint'));
  const blueprint = normalizeBlueprint(await readJson(blueprintPath));
  if (name === 'style_inspect') return inspect(blueprint);
  if (name === 'style_validate') {
    const checks = [
      ['intent', blueprint.metadata.intent.length >= 12, 'Describe the visual intent in at least 12 characters.'],
      ['shotGrammar', blueprint.shotGrammar.length > 0, 'Add at least one measured shot blueprint.'],
      ['continuity', blueprint.continuityLocks.length > 0, 'Add at least one continuity lock.'],
      ['exclusions', blueprint.negativeConstraints.length > 0, 'Add at least one negative constraint.'],
      ['reference', Boolean(blueprint.reference?.source?.path || blueprint.reference?.source?.dataUrl), 'Attach one primary reference with style_attach_reference.'],
    ];
    return { valid: checks.every(([, passed]) => passed), checks: checks.map(([field, passed, message]) => ({ field, passed, ...(passed ? {} : { message }) })), blueprint: inspect(blueprint) };
  }
  if (name === 'style_attach_reference') {
    const imagePath = resolve(required(input.image, 'image')), extension = extname(imagePath).toLowerCase(), mimeType = imageTypes[extension];
    if (!mimeType) throw new Error('Reference must be PNG, JPEG, WebP, GIF or SVG.');
    const bytes = await readFile(imagePath), targetDir = join(dirname(blueprintPath), 'reference');
    await mkdir(targetDir, { recursive: true });
    const target = join(targetDir, `primary${extension}`); await copyFile(imagePath, target);
    blueprint.reference = { name: input.name || basename(imagePath), purpose: input.purpose || 'Primary visual reference for style, composition and finish.', observations: Array.isArray(input.observations) ? input.observations.map(String).filter(Boolean).slice(0, 24) : [], source: { path: relative(dirname(blueprintPath), target), mimeType, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length } };
    await writeJson(blueprintPath, blueprint);
    return { updated: blueprintPath, reference: blueprint.reference };
  }
  if (name === 'style_compile_prompt') {
    const shot = input.shotId ? blueprint.shotGrammar.find(item => item.id === input.shotId) : null;
    if (input.shotId && !shot) throw new Error(`Unknown shotId: ${input.shotId}`);
    const shotPrompt = shot ? blueprint.promptContract.shotTemplate.replaceAll('{{shot.id}}', shot.id).replaceAll('{{shot.label}}', shot.label).replaceAll('{{shot.purpose}}', shot.purpose).replaceAll('{{shot.size}}', shot.size).replaceAll('{{shot.lensMm}}', shot.lensMm).replaceAll('{{shot.angleDeg}}', shot.angleDeg).replaceAll('{{shot.durationSec}}', shot.durationSec).replaceAll('{{shot.move}}', shot.move) : '';
    return { master: blueprint.promptContract.master, ...(shot ? { shot: shotPrompt } : {}), negative: blueprint.promptContract.negative };
  }
  if (name === 'style_export_pack') {
    const outputDir = resolve(required(input.outputDir, 'outputDir')); await mkdir(outputDir, { recursive: true });
    const packPath = await writeJson(join(outputDir, 'pack.json'), toPolyStudioPack(blueprint));
    const guidePath = join(outputDir, 'style-guide.md'); await writeFile(guidePath, styleGuideMarkdown(blueprint));
    return { outputDir, files: [packPath, guidePath], install: `Copy this folder into PolyStudio/packs/${blueprint.metadata.slug}/, then reload PolyStudio.` };
  }
  if (name === 'style_reference_sheet') {
    let dataUrl = blueprint.reference?.source?.dataUrl || '';
    if (!dataUrl && blueprint.reference?.source?.path) {
      const imagePath = resolve(dirname(blueprintPath), blueprint.reference.source.path), bytes = await readFile(imagePath), mimeType = blueprint.reference.source.mimeType || imageTypes[extname(imagePath).toLowerCase()];
      dataUrl = `data:${mimeType};base64,${bytes.toString('base64')}`;
    }
    const output = resolve(required(input.output, 'output')); await mkdir(dirname(output), { recursive: true }); await writeFile(output, referenceSheetSvg(blueprint, dataUrl));
    return { created: output, reference: blueprint.reference?.name || null, format: 'image/svg+xml' };
  }
  throw new Error(`Unknown command: ${name}`);
}

export async function fileExists(path) { try { return (await stat(path)).isFile(); } catch { return false; } }
