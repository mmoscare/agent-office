// What sort of work a worker is on — a new feature, a bug, a merge conflict… — so the office can
// colour-code it: a stripe down its task card, a badge in the workers list. The task namer's small
// model picks one; without it (or for providers it doesn't name), `guessWorkKind` reads the prompt
// and branch name.

export type WorkKind = 'feature' | 'bug' | 'merge' | 'review' | 'refactor' | 'test' | 'docs' | 'research' | 'chore';

export interface WorkKindStyle {
  label: string;
  emoji: string;
  /** The stripe and badge colour. */
  color: string;
  /** Text on top of `color`. */
  ink: string;
}

export const WORK_KINDS: Record<WorkKind, WorkKindStyle> = {
  feature: { label: 'Feature', emoji: '✨', color: '#2f9e44', ink: '#ffffff' },
  bug: { label: 'Bug fix', emoji: '🐛', color: '#e03131', ink: '#ffffff' },
  merge: { label: 'Merge / conflicts', emoji: '🔀', color: '#7048e8', ink: '#ffffff' },
  review: { label: 'Review', emoji: '🔍', color: '#1c7ed6', ink: '#ffffff' },
  refactor: { label: 'Refactor', emoji: '🧹', color: '#0c8599', ink: '#ffffff' },
  test: { label: 'Tests', emoji: '🧪', color: '#f08c00', ink: '#2b2d42' },
  docs: { label: 'Docs', emoji: '📝', color: '#66a80f', ink: '#ffffff' },
  research: { label: 'Research', emoji: '💡', color: '#d6336c', ink: '#ffffff' },
  chore: { label: 'Chore', emoji: '🔧', color: '#868e96', ink: '#ffffff' },
};

export function isWorkKind(v: unknown): v is WorkKind {
  return typeof v === 'string' && Object.hasOwn(WORK_KINDS, v);
}

// First match wins, so the most specific kinds come first: "fix the merge conflict" is a merge,
// "add tests for the login bug" is tests.
const RULES: [WorkKind, RegExp][] = [
  ['merge', /\b(merge conflicts?|conflicts?|conflicted|rebas(e|ing)|cherry-?pick|merge (upstream|main|master|in)|sync (with )?upstream|resolve .*merge)\b/i],
  ['review', /\b(review(ing)?|code review|look over|audit)\b.*\b(pr|pull request|diff|changes|code|branch)\b|\breview (pr|pull request) ?#?\d*/i],
  ['test', /\b(write|add|fix|flaky|failing|more|unit|e2e|integration) tests?\b|\btest coverage\b|\bspecs?\b/i],
  ['bug', /\b(bugs?|fix(es|ed|ing)?|broken|crash(es|ing)?|errors?|regression|doesn'?t work|not working|fails?|failing|wrong|hotfix|issue with)\b/i],
  ['docs', /\b(docs?|documentation|readme|changelog|code comments|manual|handoff notes?)\b/i],
  ['refactor', /\b(refactor(ing)?|clean ?up|simplif(y|ication)|rename|restructure|tidy|dedupe|extract)\b/i],
  ['research', /\b(brainstorm|investigate|research|explore|explain|why does|how does|figure out|look into|plan|spike|compare|analy[sz]e)\b/i],
  ['chore', /\b(bump|upgrade|update deps|dependenc(y|ies)|config(ure|uration)?|ci|lint|format|release|deploy|chore)\b/i],
  ['feature', /\b(add|build|implement|create|new|feature|support|make|introduce|enable|allow)\b/i],
];

// Branch prefixes people and tools use: fix/…, feat/…, docs/…
const BRANCH: [WorkKind, RegExp][] = [
  ['merge', /^(merge|sync|rebase)[/-]/i],
  ['bug', /^(fix|bug|bugfix|hotfix)[/-]/i],
  ['feature', /^(feat|feature)[/-]/i],
  ['docs', /^docs?[/-]/i],
  ['refactor', /^refactor[/-]/i],
  ['test', /^tests?[/-]/i],
  ['chore', /^(chore|ci|build|deps)[/-]/i],
  ['review', /^review[/-]/i],
];

/**
 * A best guess from what the worker was asked (latest prompt weighs most) and its branch name, or
 * undefined when nothing reads as one kind.
 */
export function guessWorkKind(prompts: readonly string[], branch?: string): WorkKind | undefined {
  for (const p of [...prompts].reverse()) {
    for (const [kind, re] of RULES) if (re.test(p)) return kind;
  }
  const name = branch?.replace(/^office\//, '');
  if (name) for (const [kind, re] of BRANCH) if (re.test(name)) return kind;
  return undefined;
}
