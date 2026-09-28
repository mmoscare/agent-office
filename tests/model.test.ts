import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isModelId, modelLabel, modelTag } from '../src/shared/model.js';
import { newTracker, restoreTracker, scanTracker } from '../src/server/usage.js';

test('turns model ids into the short name on a card', () => {
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(modelLabel('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(modelLabel('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
  assert.equal(modelLabel('anthropic/claude-sonnet-4-5[1m]'), 'Sonnet 4.5');
  assert.equal(modelLabel('openai/gpt-5-codex'), 'gpt-5-codex');
  assert.equal(modelTag('claude-fable-5-1', 'high'), 'Fable 5.1 · high');
  assert.equal(modelTag('claude-fable-5-1'), 'Fable 5.1');
  assert.equal(modelTag(undefined, 'high'), undefined);
  for (const bad of ['<synthetic>', 'two words', '', 'x'.repeat(101), 42]) assert.equal(isModelId(bad), false);
});

test('tracks the model and effort of the main transcript, not its subagents', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-model-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, 'session.jsonl');
  const reply = (id: string, model: string, effort?: string) =>
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-27T10:00:00Z', effort, message: { id, model, usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n';
  const tracker = newTracker();
  tracker.transcript = transcript;
  writeFileSync(transcript, reply('a', 'claude-opus-5-5', 'high') + reply('b', '<synthetic>'));
  assert.equal(scanTracker(tracker), true);
  assert.equal(tracker.model, 'claude-opus-5-5');
  assert.equal(tracker.effort, 'high');
  // Same usage again (a repeated content block) but a new effort still counts as a change.
  writeFileSync(transcript, reply('a', 'claude-opus-5-5', 'high') + reply('b', '<synthetic>') + reply('b', 'claude-opus-5-5', 'max'), { flag: 'w' });
  scanTracker(tracker);
  assert.equal(tracker.effort, 'max');
  // A subagent on another model leaves the card alone.
  mkdirSync(path.join(dir, 'session', 'subagents'), { recursive: true });
  writeFileSync(path.join(dir, 'session', 'subagents', 'agent-1.jsonl'), reply('c', 'claude-haiku-4-5', 'low'));
  assert.equal(scanTracker(tracker), true);
  assert.equal(tracker.model, 'claude-opus-5-5');
  assert.equal(tracker.effort, 'max');
  const restored = restoreTracker(JSON.parse(JSON.stringify(tracker)));
  assert.equal(restored.model, 'claude-opus-5-5');
  assert.equal(restored.effort, 'max');
});
