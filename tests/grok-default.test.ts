import test from 'node:test';
import assert from 'node:assert/strict';
import { GROK_FLAGSHIP, GROK_REFRESH_MS, createGrokDefault, modelFlag, openCodeLaunchModel, pickGrokFlagship, useGrokCatalogue } from '../src/server/grok-default.js';

/** `opencode models xai` on the owner's machine, 2026-09-28 (OpenCode 1.18.32). */
const XAI_CATALOGUE = [
  'xai/grok-4.20-0309-non-reasoning',
  'xai/grok-4.20-0309-reasoning',
  'xai/grok-4.20-multi-agent-0309',
  'xai/grok-4.3',
  'xai/grok-4.5',
  'xai/grok-4.6',
  'xai/grok-4.7',
  'xai/grok-build-0.1',
  'xai/grok-imagine-image',
  'xai/grok-imagine-image-quality',
  'xai/grok-imagine-video',
  'xai/grok-imagine-video-1.5',
];

test('the Grok pick is the flagship in the live xAI catalogue, not a fast, mini, build or multi-agent variant', () => {
  assert.equal(pickGrokFlagship(XAI_CATALOGUE), 'xai/grok-4.7');
  assert.equal(pickGrokFlagship(['anthropic/claude-sonnet-4', ...XAI_CATALOGUE, 'openai/gpt-5']), GROK_FLAGSHIP);
  // A new plain release wins without a code change; its cheaper variants and aliases never do.
  assert.equal(pickGrokFlagship([...XAI_CATALOGUE, 'xai/grok-5-fast', 'xai/grok-5-mini', 'xai/grok-5-latest', 'xai/grok-6-0101-reasoning']), 'xai/grok-4.7');
  assert.equal(pickGrokFlagship([...XAI_CATALOGUE, 'xai/grok-5', 'xai/grok-5-fast']), 'xai/grok-5');
  // xAI numbers releases as decimals: Grok 4.20 came out before 4.3.
  assert.equal(pickGrokFlagship(['xai/grok-4.20', 'xai/grok-4.3']), 'xai/grok-4.3');
  // Grok through another provider isn't xAI's own.
  assert.equal(pickGrokFlagship(['openrouter/x-ai/grok-9', 'xai/grok-build-0.1']), undefined);
  assert.equal(pickGrokFlagship([]), undefined);
});

test('the office default falls back to the fixed flagship when the catalogue is unavailable, and keeps its last good pick', async () => {
  assert.equal(createGrokDefault().current(), GROK_FLAGSHIP);

  const down = createGrokDefault({ get: async () => { throw new Error('OpenCode model catalogue unavailable'); } });
  assert.equal(await down.refresh(), GROK_FLAGSHIP);
  assert.equal(down.current(), GROK_FLAGSHIP);

  let models: string[] | Error = [...XAI_CATALOGUE, 'xai/grok-5'];
  let calls = 0;
  let now = 0;
  const catalogue = {
    get: async () => {
      calls++;
      if (models instanceof Error) throw models;
      return models;
    },
  };
  const office = createGrokDefault(catalogue, () => now);
  assert.equal(office.current(), GROK_FLAGSHIP, 'the first launch never waits on the catalogue');
  assert.equal(await office.refresh(), 'xai/grok-5');
  assert.equal(office.current(), 'xai/grok-5');
  models = new Error('offline');
  assert.equal(await office.refresh(), 'xai/grok-5');
  models = ['openai/gpt-5'];
  assert.equal(await office.refresh(), 'xai/grok-5', 'a catalogue with no plain Grok keeps the last pick');

  // A launch re-reads the catalogue in the background once the pick is an hour old.
  models = [...XAI_CATALOGUE, 'xai/grok-5', 'xai/grok-5.1'];
  const before = calls;
  assert.equal(office.current(), 'xai/grok-5');
  assert.equal(calls, before);
  now += GROK_REFRESH_MS;
  assert.equal(office.current(), 'xai/grok-5');
  assert.equal(calls, before + 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(office.current(), 'xai/grok-5.1');
});

test('a chosen model wins, then an office-wide --model, then the Grok flagship', async (t) => {
  t.after(() => useGrokCatalogue());
  useGrokCatalogue();
  assert.equal(openCodeLaunchModel(undefined, []), GROK_FLAGSHIP);
  assert.equal(openCodeLaunchModel(undefined, ['--keep', 'yes']), GROK_FLAGSHIP);
  assert.equal(openCodeLaunchModel('openai/gpt-5', ['--model', 'configured/model']), 'openai/gpt-5');
  assert.equal(openCodeLaunchModel(undefined, ['--model', 'configured/model', '--keep', 'yes']), 'configured/model');
  await useGrokCatalogue({ get: async () => [...XAI_CATALOGUE, 'xai/grok-5'] }).refresh();
  assert.equal(openCodeLaunchModel(undefined, []), 'xai/grok-5');
  assert.equal(openCodeLaunchModel('xai/grok-4.3', []), 'xai/grok-4.3');
});

test('office-wide model flags are read the way the launcher strips them', () => {
  assert.equal(modelFlag([]), undefined);
  assert.equal(modelFlag(['--model', 'old/model', '--keep', 'yes', '-m', 'older/model']), 'older/model');
  assert.equal(modelFlag(['--model=xai/grok-4.6']), 'xai/grok-4.6');
  assert.equal(modelFlag(['-mxai/grok-4.5']), 'xai/grok-4.5');
  assert.equal(modelFlag(['--model', '--keep']), undefined);
  assert.equal(modelFlag(['--model', 'no-provider']), undefined, 'an unusable id leaves the Grok default in charge');
});
