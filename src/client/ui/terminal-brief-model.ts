import type { WorkerInfo } from '../../shared/protocol';

/** One row of the brief atop an agent's terminal. */
export interface BriefLine {
  key: 'asked' | 'latest' | 'task' | 'now';
  label: string;
  text: string;
}

type BriefWorker = Pick<WorkerInfo, 'kind' | 'status' | 'ask' | 'task' | 'activity'>;

const flat = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** True when `line` is just the start of one of the asks (a prompt shown as activity, or a task summary made from it). */
function echoes(line: string, asks: string[]): boolean {
  const start = flat(line).replace(/…$/, '').trim();
  return !!start && asks.some((a) => flat(a).startsWith(start));
}

/** What you asked the agent and what it's on: the rows to show, most important first. */
export function briefLines(w: BriefWorker): BriefLine[] {
  if (w.kind !== 'agent') return [];
  const lines: BriefLine[] = [];
  const asks = [w.ask?.first, w.ask?.latest].filter((a): a is string => !!a);
  if (w.ask?.first) lines.push({ key: 'asked', label: 'You asked', text: w.ask.first });
  if (w.ask?.latest) lines.push({ key: 'latest', label: 'Latest ask', text: w.ask.latest });
  if (w.task) {
    // Without a namer the summary is the prompt itself, already shown above.
    const summary = w.task.summary && !echoes(w.task.summary, asks) ? w.task.summary : '';
    lines.push({ key: 'task', label: 'Working on', text: summary ? `${w.task.name} — ${summary}` : w.task.name });
  }
  // Its latest step, while it's at work: once it stops, that's often just the reply it was last sent.
  const busy = w.status === 'working' || w.status === 'needs_input';
  if (busy && w.activity && !echoes(w.activity, asks)) lines.push({ key: 'now', label: 'Now', text: w.activity });
  return lines;
}
