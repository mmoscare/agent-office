export const PLAN_COLUMNS = { todo: 'To Do', progress: 'Progress', finished: 'Finished' } as const;
export type PlanStatus = keyof typeof PLAN_COLUMNS;
export const PLAN_TEXT_MAX = 10_000;
export const PLAN_LIMIT = 1000;
export interface Plan { id: string; text: string; status: PlanStatus }
export interface PlansState { revision: number; items: Plan[] }
export type PlanAction = { action: 'add'; text: string } | { action: 'edit'; id: string; text?: string; status?: PlanStatus } | { action: 'remove'; id: string };
export function isPlanStatus(value: unknown): value is PlanStatus {
  return value === 'todo' || value === 'progress' || value === 'finished';
}
