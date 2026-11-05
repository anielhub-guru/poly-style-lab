#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { TOOL_DEFINITIONS, runCommand } from '../src/commands.js';

const reply = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const ok = result => ({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: false });
const fail = error => ({ content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true });

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === 'notifications/initialized') return;
  if (request.method === 'initialize') return reply({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'poly-style-lab', version: '0.1.0' } } });
  if (request.method === 'ping') return reply({ jsonrpc: '2.0', id: request.id, result: {} });
  if (request.method === 'tools/list') return reply({ jsonrpc: '2.0', id: request.id, result: { tools: TOOL_DEFINITIONS.map(({ readOnlyHint, ...tool }) => ({ ...tool, annotations: { readOnlyHint: Boolean(readOnlyHint), destructiveHint: false } })) } });
  if (request.method === 'tools/call') {
    let result; try { result = ok(await runCommand(request.params?.name, request.params?.arguments || {})); } catch (error) { result = fail(error); }
    return reply({ jsonrpc: '2.0', id: request.id, result });
  }
  if (request.id !== undefined) reply({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } });
});
