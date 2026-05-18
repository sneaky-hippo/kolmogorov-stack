// W269 — agent composition primitives inside .kolm.
//
// The W286 workflow_capsule class gave us a deterministic interpreter over a
// DAG of (input, llm, tool, branch, artifact, const, output) nodes. That
// covers multi-step graphs. To compose actual agents the IR also needs:
//
//   1. MEMORY_READ / MEMORY_WRITE nodes — a per-run key-value scratchpad that
//      the interpreter exposes via opts.memory (a Map-shaped object). A
//      MEMORY_READ node binds env[id] to memory.get(key). A MEMORY_WRITE node
//      binds env[id] to the written value AND mutates the store.
//   2. ir.tool_registry — optional whitelist of tool names the IR is
//      ALLOWED to call. If present and non-empty, every TOOL node whose
//      tool_name is missing from the registry is rejected by validateIr.
//      Closed-by-default for safety: an IR that ships a non-empty registry
//      cannot drive a tool the manifest never authorized.
//   3. composition continues to work via ARTIFACT nodes (already in W286).
//      The test here pins that the memory store is THREADED to the sub-IR
//      so a composed agent can read what an earlier specialist wrote.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKFLOW_IR_VERSION,
  NODE_KINDS,
  validateIr,
  interpret,
} from '../src/workflow-ir.js';

const baseIr = (nodes, edges, seeds = [], extra = {}) => ({
  spec: WORKFLOW_IR_VERSION,
  nodes,
  edges,
  seeds,
  ...extra,
});

test('W269 NODE_KINDS exports memory_read + memory_write', () => {
  assert.equal(NODE_KINDS.MEMORY_READ, 'memory_read');
  assert.equal(NODE_KINDS.MEMORY_WRITE, 'memory_write');
});

test('W269 validateIr accepts memory_read + memory_write', () => {
  const ir = baseIr(
    [
      { id: 'in', kind: 'input' },
      { id: 'r', kind: 'memory_read', key: 'k' },
      { id: 'w', kind: 'memory_write', key: 'k2', value_template: { ref: 'in' } },
      { id: 'out', kind: 'output', value_template: { ref: 'w' } },
    ],
    [
      { from: 'in', to: 'r' },
      { from: 'r', to: 'w' },
      { from: 'w', to: 'out' },
    ],
  );
  assert.equal(validateIr(ir), true);
});

test('W269 memory_read returns null when key missing (does not throw)', async () => {
  const ir = baseIr(
    [
      { id: 'in', kind: 'input' },
      { id: 'r', kind: 'memory_read', key: 'absent' },
      { id: 'out', kind: 'output', value_template: { ref: 'r' } },
    ],
    [
      { from: 'in', to: 'r' },
      { from: 'r', to: 'out' },
    ],
  );
  const memory = new Map();
  const { output } = await interpret(ir, 'anything', { memory });
  assert.equal(output, null);
});

test('W269 memory_write mutates the store and binds the written value', async () => {
  const ir = baseIr(
    [
      { id: 'in', kind: 'input' },
      { id: 'w', kind: 'memory_write', key: 'scratch', value_template: { ref: 'in' } },
      { id: 'out', kind: 'output', value_template: { ref: 'w' } },
    ],
    [
      { from: 'in', to: 'w' },
      { from: 'w', to: 'out' },
    ],
  );
  const memory = new Map();
  const { output } = await interpret(ir, 'hello', { memory });
  assert.equal(output, 'hello');
  assert.equal(memory.get('scratch'), 'hello');
});

test('W269 memory_read after memory_write in same run sees the value', async () => {
  const ir = baseIr(
    [
      { id: 'in', kind: 'input' },
      { id: 'w', kind: 'memory_write', key: 'k', value_template: { ref: 'in' } },
      { id: 'r', kind: 'memory_read', key: 'k' },
      { id: 'out', kind: 'output', value_template: { ref: 'r' } },
    ],
    [
      { from: 'in', to: 'w' },
      { from: 'w', to: 'r' },
      { from: 'r', to: 'out' },
    ],
  );
  const memory = new Map();
  const { output } = await interpret(ir, 'persisted', { memory });
  assert.equal(output, 'persisted');
});

test('W269 tool_registry whitelists tool names — TOOL node not in registry is rejected', () => {
  const ir = baseIr(
    [
      { id: 'in', kind: 'input' },
      { id: 't', kind: 'tool', tool_name: 'forbidden_tool', args_template: { ref: 'in' } },
      { id: 'out', kind: 'output', value_template: { ref: 't' } },
    ],
    [
      { from: 'in', to: 't' },
      { from: 't', to: 'out' },
    ],
    [],
    { tool_registry: ['allowed_tool'] },
  );
  assert.throws(() => validateIr(ir), /tool_registry|forbidden|not.*allowed/i);
});

test('W269 tool_registry empty array means no tools allowed (closed by default)', () => {
  const ir = baseIr(
    [
      { id: 'in', kind: 'input' },
      { id: 't', kind: 'tool', tool_name: 'anything', args_template: { ref: 'in' } },
      { id: 'out', kind: 'output', value_template: { ref: 't' } },
    ],
    [
      { from: 'in', to: 't' },
      { from: 't', to: 'out' },
    ],
    [],
    { tool_registry: [] },
  );
  assert.throws(() => validateIr(ir), /tool_registry|not.*allowed/i);
});

test('W269 absent tool_registry (legacy) does NOT gate tools — back-compat', () => {
  const ir = baseIr(
    [
      { id: 'in', kind: 'input' },
      { id: 't', kind: 'tool', tool_name: 'anything', args_template: { ref: 'in' } },
      { id: 'out', kind: 'output', value_template: { ref: 't' } },
    ],
    [
      { from: 'in', to: 't' },
      { from: 't', to: 'out' },
    ],
  );
  assert.equal(validateIr(ir), true);
});

test('W269 memory store threads through to ARTIFACT sub-IR via opts.exec.artifact', async () => {
  // The parent IR writes "shared_key" then invokes an ARTIFACT node. The
  // exec.artifact stub receives the parent memory in its third argument so
  // composed specialists can build on what earlier specialists wrote.
  const parent = baseIr(
    [
      { id: 'in', kind: 'input' },
      { id: 'w', kind: 'memory_write', key: 'shared', value_template: { ref: 'in' } },
      { id: 'a', kind: 'artifact', artifact_hash: 'sub-1', recipe_id: 'r1', input_template: 'go' },
      { id: 'out', kind: 'output', value_template: { ref: 'a' } },
    ],
    [
      { from: 'in', to: 'w' },
      { from: 'w', to: 'a' },
      { from: 'a', to: 'out' },
    ],
  );
  const memory = new Map();
  let seenSharedInSub = null;
  const exec = {
    artifact: async (_node, _subInput, ctx) => {
      seenSharedInSub = ctx && ctx.memory ? ctx.memory.get('shared') : null;
      return 'child-output';
    },
  };
  const { output } = await interpret(parent, 'parent-input', { memory, exec });
  assert.equal(output, 'child-output');
  assert.equal(seenSharedInSub, 'parent-input');
});
