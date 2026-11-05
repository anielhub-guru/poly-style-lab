#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { TOOL_DEFINITIONS, runCommand } from '../src/commands.js';

const HELP = `Usage:
  poly-style-lab tools [--json]
  poly-style-lab <tool> --input JSON|@FILE [--json]

Examples:
  poly-style-lab style_analyze_channel --input '{"source":"https://youtube.com/@channel/videos","outputDir":"./study","videoCount":15}' --json
  poly-style-lab style_list_presets --json
  poly-style-lab style_create --input '{"preset":"stormbound-shonen","output":"./style.json"}'
  poly-style-lab style_attach_reference --input @attach-reference.json
  poly-style-lab style_export_pack --input '{"blueprint":"./style.json","outputDir":"./pack"}'
`;

function parse(argv) {
  const args = [...argv], command = args.shift();
  if (!command || ['help', '--help', '-h'].includes(command)) return { command: 'help' };
  const options = { command, input: {}, json: false };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--json') options.json = true;
    else if (flag === '--input' || flag === '-i') {
      const value = args.shift(); if (!value) throw new Error(`${flag} needs a value`);
      const source = value.startsWith('@') ? readFileSync(value.slice(1), 'utf8') : value;
      options.input = JSON.parse(source);
    } else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

try {
  const options = parse(process.argv.slice(2));
  if (options.command === 'help') process.stdout.write(HELP);
  else if (options.command === 'tools') process.stdout.write(options.json ? `${JSON.stringify(TOOL_DEFINITIONS)}\n` : `${TOOL_DEFINITIONS.map(tool => `${tool.name}\t${tool.description}`).join('\n')}\n`);
  else {
    const result = await runCommand(options.command, options.input);
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
}
