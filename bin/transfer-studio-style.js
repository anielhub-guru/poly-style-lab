#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { applyStudioStyle, buildStudioStyle } from '../src/style-transfer.js';

const [analysisPath, projectPath, outputPath] = process.argv.slice(2);
if (!analysisPath || !projectPath || !outputPath) {
  console.error('Usage: node bin/transfer-studio-style.js <look-or-measurement.json> <project.story.json> <output.story.json>');
  process.exitCode = 1;
} else {
  const [analysis, project] = await Promise.all([analysisPath, projectPath].map(async path => JSON.parse(await readFile(path, 'utf8'))));
  const style = buildStudioStyle(analysis.look || analysis);
  await writeFile(outputPath, JSON.stringify(applyStudioStyle(project, style), null, 2) + '\n');
}
