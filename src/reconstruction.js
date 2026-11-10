import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { projectRoot } from './environment.js';
import { runProcess } from './process.js';
import { embedRigInAikiScene } from './aikiscene.js';

const script = join(projectRoot, 'analysis', 'reconstruct_frame.py');
const rigScript = join(projectRoot, 'analysis', 'rig_characters.py');
const finiteScore = value => Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;

/** Select the evidence frame with the lowest measured vector error and export a Three.js handoff. */
export async function reconstructStudy({ workspace, measurements, env, quality = 'standard' }) {
  const candidates = [];
  for (const measurement of measurements) {
    if (!measurement.evidence?.image) continue;
    const image = join(workspace, measurement.evidence.image);
    try {
      const process = await runProcess(env.python, [script, image, '--measure-only'], { timeoutMs: 60_000 });
      const metrics = JSON.parse(process.stdout);
      candidates.push({ measurement, image, metrics });
    } catch { /* one unsuitable evidence frame must not block the study */ }
  }
  if (!candidates.length) return { available: false, reason: 'No evidence frame could be reconstructed.' };

  candidates.sort((a, b) => finiteScore(a.metrics.selectionScore) - finiteScore(b.metrics.selectionScore));
  const selected = candidates[0], outputDir = join(workspace, 'reconstruction');
  await mkdir(outputDir, { recursive: true });
  const exportArgs = [script, selected.image, '--output-dir', outputDir, '--quality', quality];
  if (selected.measurement.temporal?.available) {
    const temporalPath = join(outputDir, 'temporal-input.json');
    await writeFile(temporalPath, `${JSON.stringify(selected.measurement.temporal)}\n`);
    exportArgs.push('--temporal', temporalPath);
  }
  await runProcess(env.python, exportArgs, { timeoutMs: 120_000 });

  const blueprintPath = join(outputDir, 'visual-reconstruction-blueprint.json');
  const blueprint = JSON.parse(await readFile(blueprintPath, 'utf8'));
  blueprint.source = {
    videoId: selected.measurement.source.id,
    title: selected.measurement.source.title,
    evidenceImage: relative(workspace, selected.image),
    timeSec: selected.measurement.evidence.timeSec,
    selection: 'lowest complexity-adjusted measured vector reconstruction error',
  };
  blueprint.candidates = candidates.map(candidate => ({
    videoId: candidate.measurement.source.id,
    evidenceImage: relative(workspace, candidate.image),
    selectionScore: candidate.metrics.selectionScore,
    rmseRgb: candidate.metrics.rmseRgb,
    structuralSimilarity: candidate.metrics.structuralSimilarity,
    edgeF1: candidate.metrics.edgeF1,
    edgeDensity: candidate.metrics.edgeDensity,
    paletteEntropy: candidate.metrics.paletteEntropy,
    informationPenalty: candidate.metrics.informationPenalty,
    regionCount: candidate.metrics.regionCount,
  }));
  await writeFile(blueprintPath, `${JSON.stringify(blueprint, null, 2)}\n`);

  const subjectLayers = blueprint.components.semanticLayers.filter(layer => ['subject-candidate', 'character-candidate'].includes(layer.role));
  if (subjectLayers.length || blueprint.components.character.available) {
    const rigDir = join(outputDir, 'rig');
    const rigArgs = [rigScript, blueprintPath];
    if (blueprint.files.temporalTracks) rigArgs.push(join(outputDir, blueprint.files.temporalTracks));
    rigArgs.push('--output-dir', rigDir);
    await runProcess(env.python, rigArgs, { timeoutMs: 30_000 });
    blueprint.files.rigDefinition = 'rig/rig-definition.json';
    blueprint.files.rigModule = 'rig/rig-definition.js';
    await embedRigInAikiScene({
      scenePath: join(outputDir, blueprint.files.aikiScene),
      rigPath: join(outputDir, blueprint.files.rigDefinition),
    });
    await writeFile(blueprintPath, `${JSON.stringify(blueprint, null, 2)}\n`);
  }

  return {
    available: true,
    representation: blueprint.representation.type,
    confidence: blueprint.reconstruction.confidence,
    selected: blueprint.source,
    metrics: blueprint.reconstruction,
    complexity: blueprint.geometry,
    outputDir,
    files: Object.fromEntries(Object.entries(blueprint.files).map(([key, value]) => [key, join(outputDir, value)])),
    blueprint: blueprintPath,
  };
}
