import test from 'node:test';
import assert from 'node:assert/strict';
import { agentForBranch } from '../src/shared/pulls.js';

test('names the agent an office branch was made for', () => {
  assert.equal(agentForBranch('office/widget-0200'), 'Widget');
  assert.equal(agentForBranch('office/sprocket-f07b'), 'Sprocket');
  assert.equal(agentForBranch('office/byte-1a2b3c4d5e6f'), 'Byte');
});

test('names no agent for other branches', () => {
  assert.equal(agentForBranch('main'), undefined);
  assert.equal(agentForBranch('feature/widget-0200'), undefined);
  assert.equal(agentForBranch('office/test'), undefined);
  assert.equal(agentForBranch('office/meeting-plan-ab12'), undefined);
  assert.equal(agentForBranch('office/meeting-ab12'), undefined);
});
