// Which company's mark to show for a worker's model. The id wins over the harness:
// OpenCode running Grok is xAI, not an OpenCode logo.

export const MODEL_BRANDS = ['xai', 'openai', 'anthropic', 'google', 'meta', 'mistral', 'deepseek', 'qwen', 'cohere', 'perplexity', 'amazon', 'microsoft'] as const;
export type ModelBrand = (typeof MODEL_BRANDS)[number];

export const MODEL_BRAND_LABEL: Record<ModelBrand, string> = {
  xai: 'xAI',
  openai: 'ChatGPT',
  anthropic: 'Anthropic',
  google: 'Gemini',
  meta: 'Llama',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  cohere: 'Cohere',
  perplexity: 'Perplexity',
  amazon: 'Amazon',
  microsoft: 'Microsoft',
};

/** Family first, so a host prefix (groq/llama) doesn't hide the model. */
const RULES: [ModelBrand, RegExp][] = [
  ['xai', /grok|(^|[/:.])x-?ai($|[/:.])/],
  ['meta', /llama/],
  ['deepseek', /deepseek/],
  ['qwen', /qwen|qwq/],
  ['mistral', /mistral|mixtral|codestral|pixtral|magistral/],
  ['google', /gemini|gemma/],
  ['anthropic', /claude|anthropic|(^|[/:.])(fable|opus|sonnet|haiku)($|[/:.])/],
  ['openai', /gpt|chatgpt|dall-e|codex|(^|[/:.])openai($|[/:.])|(^|[/:.])o[134]($|[-./:])/],
  ['cohere', /cohere|command-r|command-a|(^|[/:.])aya($|[-./:])/],
  ['perplexity', /perplexity|(^|[/:.])sonar($|[-./:])/],
  ['amazon', /(^|[/:.])amazon($|[/:.])|(^|[/:.])nova($|[-./:])/],
  ['microsoft', /copilot|(^|[/:.])phi-\d/],
];

/**
 * The mark for this model. `provider` is only a fallback when the id doesn't name a family
 * (a Claude or Codex worker that hasn't reported a model yet).
 */
export function modelBrand(model: string | undefined, provider?: string): ModelBrand | undefined {
  const id = model?.trim().toLowerCase();
  if (id) {
    for (const [brand, rule] of RULES) if (rule.test(id)) return brand;
  }
  if (provider === 'claude') return 'anthropic';
  if (provider === 'codex') return 'openai';
  return undefined;
}
