// Model ids as the transcripts spell them, turned into the short name on a worker's card.

/** Ids we'll carry to the browser: model-shaped, no whitespace, nothing long. */
export function isModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && /^[A-Za-z0-9][\w.:/@\[\]-]*$/.test(value);
}

/** Reasoning effort as the transcripts spell it: "low", "medium", "high", "xhigh", "max"… */
export function isEffort(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z]{1,12}$/.test(value);
}

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];

/**
 * "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5",
 * "claude-3-5-sonnet-20241022" → "Sonnet 3.5", "anthropic/claude-sonnet-4" → "Sonnet 4".
 * Anything else loses only its provider prefix: "openai/gpt-5-codex" → "gpt-5-codex".
 */
export function modelLabel(id: string): string {
  const bare = id.slice(id.lastIndexOf('/') + 1).replace(/\[[^\]]*\]$/, '');
  const parts = bare.toLowerCase().replace(/^claude-/, '').split(/[-_.]/);
  const family = parts.find((p) => FAMILIES.includes(p));
  if (!family) return bare;
  // Version numbers, minus a trailing date stamp like 20251001.
  const version = parts.filter((p) => /^\d{1,2}$/.test(p));
  return `${family[0].toUpperCase()}${family.slice(1)}${version.length ? ` ${version.join('.')}` : ''}`;
}

/** The tab on a worker's card: "Opus 5.5 · high", or just "Opus 5.5" when the effort isn't known. */
export function modelTag(model: string | undefined, effort?: string): string | undefined {
  if (!model) return undefined;
  return effort ? `${modelLabel(model)} · ${effort}` : modelLabel(model);
}
