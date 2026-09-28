export const PLAN_COLUMNS = { todo: 'To Do', progress: 'Progress', finished: 'Finished' } as const;
export type PlanStatus = keyof typeof PLAN_COLUMNS;
export const PLAN_TEXT_MAX = 10_000;
export const PLAN_LIMIT = 1000;
/** How much of a plan's first line makes its title on a queue task or a card. */
export const PLAN_TITLE_MAX = 120;
export interface Plan {
  id: string;
  text: string;
  status: PlanStatus;
  /** The 📋 queue task it was handed to, when it was (see server/queue.ts): the office moves it along as the task runs. */
  task?: string;
  /** The worker on it: seated by the queue, or handed it at a desk. Cleared when that worker goes home. */
  worker?: { id: string; name: string };
  /** When it last moved to Finished. */
  finishedAt?: number;
}
export interface PlansState { revision: number; items: Plan[] }
export type PlanAction = { action: 'add'; text: string } | { action: 'edit'; id: string; text?: string; status?: PlanStatus } | { action: 'remove'; id: string };
export function isPlanStatus(value: unknown): value is PlanStatus {
  return value === 'todo' || value === 'progress' || value === 'finished';
}

/** A plan's first line, for a task title or a card. */
export function planTitle(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l) ?? '';
  return line.length > PLAN_TITLE_MAX ? `${line.slice(0, PLAN_TITLE_MAX - 1)}…` : line;
}

/** What a worker is told when it's handed a plan, at a desk or from the queue. */
export function planPrompt(plan: Pick<Plan, 'text'>): string {
  return `${plan.text.trim()}\n\nThis is an item on the floor's 📒 To Do Next board (the people here keep their own list of what they want done on it). Do what it asks, then say what you did: the office moves the item to Finished when your turn ends.`;
}
