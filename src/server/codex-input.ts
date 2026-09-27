/**
 * Codex hooks describe attempted actions, not whether the TUI needs a person.
 * Match the live input controls at the bottom of the viewport, never question
 * marks or assistant prose. This also handles prompts without a tool-call ID.
 */
export function codexInputPrompt(screen: string): string | undefined {
  const lines = screen.split('\n').map(line => line.trim()).filter(Boolean);
  const footer = lines.slice(-2).join(' ');
  const text = lines.join('\n');
  if (/\bto submit (?:answer|all)\b/i.test(footer)
    && /\b(?:to submit (?:answer|all)|to interrupt|change question|to navigate questions)$/i.test(footer)
    && /\bQuestion \d+\/\d+\b/.test(text)) {
    return 'Waiting for your answer in the terminal';
  }
  const setup = /trust (?:the|this) (?:directory|folder)|Do you trust|Sign in with ChatGPT|Provide your own API key/i.test(text);
  if (setup && /\benter to continue[.!]?$/i.test(footer)) {
    return 'Waiting on Codex setup in the terminal';
  }
  if (!/\bto confirm\b.*\bto cancel(?: or .+ to open thread)?$/i.test(footer)) return undefined;
  if (/Would you like to (?:run the following command|send input to|grant these permissions|make the following edits)|Do you want to approve network access|needs your approval\./i.test(text)) {
    return 'Waiting for your approval in the terminal';
  }
  if (setup) {
    return 'Waiting on Codex setup in the terminal';
  }
  return undefined;
}
