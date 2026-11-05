import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../src/commands.js';

test('agent command workflow creates, references, validates and exports a style', async () => {
  const root = await mkdtemp(join(tmpdir(), 'poly-style-lab-'));
  const blueprint = join(root, 'style', 'blueprint.json');
  const image = join(root, 'reference.png');
  await writeFile(image, Buffer.from('89504e470d0a1a0a', 'hex'));
  const created = await runCommand('style_create', { output: blueprint, preset: 'stormbound-shonen' });
  assert.equal(created.blueprint.slug, 'stormbound-shonen');
  const attached = await runCommand('style_attach_reference', { blueprint, image, observations: ['Angular silhouettes', 'Cool ground and warm accent'] });
  assert.equal(attached.reference.observations.length, 2);
  assert.equal(attached.reference.source.mimeType, 'image/png');
  const validation = await runCommand('style_validate', { blueprint });
  assert.equal(validation.valid, true);
  const pack = await runCommand('style_export_pack', { blueprint, outputDir: join(root, 'pack') });
  assert.equal(pack.files.length, 2);
  assert.equal(JSON.parse(await readFile(pack.files[0], 'utf8')).type, 'story-format');
  const sheet = await runCommand('style_reference_sheet', { blueprint, output: join(root, 'sheet.svg') });
  assert.match(await readFile(sheet.created, 'utf8'), /Angular silhouettes/);
});

test('validation explains a missing primary reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'poly-style-lab-'));
  const blueprint = join(root, 'blueprint.json');
  await runCommand('style_create', { output: blueprint });
  const validation = await runCommand('style_validate', { blueprint });
  assert.equal(validation.valid, false);
  assert.match(validation.checks.find(check => check.field === 'reference').message, /Attach one primary reference/);
});
