// What a worker was asked, for the brief at the top of its terminal: the request that started it
// and its latest one, as the person wrote them, without the notes the office adds around them.

import type { WorkerAsk } from '../shared/protocol.js';
import { WORKTREE_NOTE, withoutCheckpoint, withoutWorkerHandoff } from './handoff.js';

const ASK_MAX = 1000;
/** Replies this short ("yes", "go ahead", "2") answer the agent within the same request. */
const REPLY_MAX = 16;

/** A prompt as the person wrote it: no handoff, checkpoint or worktree note, and clipped. */
export function requestOf(prompt: string): string {
  let text = withoutCheckpoint(withoutWorkerHandoff(prompt.replace(/\r\n?/g, '\n')));
  if (text.endsWith(WORKTREE_NOTE)) text = text.slice(0, -WORKTREE_NOTE.length);
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > ASK_MAX ? `${text.slice(0, ASK_MAX - 1)}…` : text;
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The worker's asks once `prompt` has been sent to it. */
export function nextAsk(ask: WorkerAsk | undefined, prompt: string): WorkerAsk | undefined {
  const text = requestOf(prompt);
  // Bare slash commands (/model, /compact) aren't requests.
  if (!text || /^\/\S+$/.test(text)) return ask;
  if (!ask) return { first: text };
  const one = flat(text);
  const first = flat(ask.first);
  // The same request again, e.g. echoed back by a hook with a desk or board brief in front of it.
  if (one === first || one.endsWith(` ${first}`) || (ask.latest && one === flat(ask.latest))) return ask;
  if (one.length < REPLY_MAX) return ask;
  return { first: ask.first, latest: text };
}

/** A saved ask, or one made from the saved prompt of a worker from before asks were kept. */
export function savedAsk(v: unknown, prompt?: string): WorkerAsk | undefined {
  const a = v as Partial<WorkerAsk> | undefined;
  if (typeof a?.first === 'string' && a.first) return typeof a.latest === 'string' && a.latest ? { first: a.first, latest: a.latest } : { first: a.first };
  return prompt ? nextAsk(undefined, prompt) : undefined;
}
