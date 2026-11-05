import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/poly-style-lab.js', import.meta.url));
const mcp = fileURLToPath(new URL('../mcp/server.js', import.meta.url));

test('CLI exposes the shared command registry as JSON', async () => {
  const { stdout } = await exec(process.execPath, [cli, 'style_list_presets', '--json']);
  const presets = JSON.parse(stdout);
  assert.ok(presets.some(item => item.id === 'stormbound-shonen'));
});

test('MCP stdio initializes and lists the shared tools', async () => {
  const child = spawn(process.execPath, [mcp], { stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [];
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) if (line.trim()) messages.push(JSON.parse(line));
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('MCP response timeout')), 2000);
    const poll = setInterval(() => { if (messages.length >= 2) { clearInterval(poll); clearTimeout(timeout); resolve(); } }, 10);
  });
  child.kill();
  assert.equal(messages[0].result.serverInfo.name, 'poly-style-lab');
  assert.ok(messages[1].result.tools.some(tool => tool.name === 'style_analyze_channel'));
  assert.ok(messages[1].result.tools.some(tool => tool.name === 'style_attach_reference'));
  assert.ok(messages[1].result.tools.some(tool => tool.name === 'style_export_pack'));
});
