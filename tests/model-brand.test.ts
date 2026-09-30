import test from 'node:test';
import assert from 'node:assert/strict';
import { modelBrand } from '../src/shared/model-brand.js';

test('Grok is xAI, including a host prefix that is not the model', () => {
  assert.equal(modelBrand('xai/grok-4.7'), 'xai');
  assert.equal(modelBrand('grok-4.7'), 'xai');
  assert.equal(modelBrand('openrouter/x-ai/grok-4'), 'xai');
  assert.equal(modelBrand('xai/grok-imagine-image'), 'xai');
  assert.equal(modelBrand('x-ai/grok-build-0.1'), 'xai');
  assert.equal(modelBrand('groq/llama-3.3-70b'), 'meta');
});

test('ChatGPT, Codex and GPT share the OpenAI mark; Claude and Anthropic do not', () => {
  assert.equal(modelBrand('openai/gpt-5-codex'), 'openai');
  assert.equal(modelBrand('gpt-5'), 'openai');
  assert.equal(modelBrand('chatgpt-4o'), 'openai');
  assert.equal(modelBrand('o3-mini'), 'openai');
  assert.equal(modelBrand('openai/o1'), 'openai');
  assert.equal(modelBrand(undefined, 'codex'), 'openai');
  assert.equal(modelBrand('claude-opus-5-5'), 'anthropic');
  assert.equal(modelBrand('anthropic/claude-sonnet-4-5'), 'anthropic');
  assert.equal(modelBrand('opus', 'claude'), 'anthropic');
  assert.equal(modelBrand('haiku', 'claude'), 'anthropic');
  assert.equal(modelBrand(undefined, 'claude'), 'anthropic');
});

test('other families, and no guess when the model is unknown', () => {
  assert.equal(modelBrand('google/gemini-2.5-pro'), 'google');
  assert.equal(modelBrand('gemma-3'), 'google');
  assert.equal(modelBrand('meta-llama/llama-3.1-70b'), 'meta');
  assert.equal(modelBrand('mistral/mistral-large'), 'mistral');
  assert.equal(modelBrand('mixtral-8x7b'), 'mistral');
  assert.equal(modelBrand('deepseek/deepseek-chat'), 'deepseek');
  assert.equal(modelBrand('qwen/qwen-2.5-coder'), 'qwen');
  assert.equal(modelBrand('cohere/command-r'), 'cohere');
  assert.equal(modelBrand('perplexity/sonar'), 'perplexity');
  assert.equal(modelBrand('amazon/nova-pro'), 'amazon');
  assert.equal(modelBrand('microsoft/phi-4'), 'microsoft');
  assert.equal(modelBrand(undefined, 'opencode'), undefined);
  assert.equal(modelBrand('some-custom-model', 'custom'), undefined);
  assert.equal(modelBrand(undefined, undefined), undefined);
});
