export interface PushTarget {
  id: string;
  name: string;
  dir: string;
  kind: 'floor' | 'office';
  branch?: string;
  destination?: string;
  ahead: number;
  behind: number;
  dirty: number;
  published: boolean;
  hasCommits: boolean;
  error?: string;
}
export interface PushTargets { targets: PushTarget[]; truncated: boolean }
export interface PushPreview {
  target: PushTarget;
  commits: { hash: string; subject: string }[];
  /** A short-lived server-side review of this exact checkout, branch and set of commits. */
  token?: string;
  checkedAt: number;
}
export function pushAdvice(s: PushTarget): { title: string; detail: string; ready: boolean } {
  if (s.error) return { title: 'Push unavailable', detail: s.error, ready: false };
  if (!s.branch) return { title: 'Choose a branch first', detail: 'This checkout has a detached HEAD. Switch to the intended branch before pushing.', ready: false };
  if (!s.hasCommits) return { title: 'Commit first', detail: 'Save your completed changes in a commit, then return here to push it.', ready: false };
  if (!s.destination) return { title: 'No destination configured', detail: 'Set up an origin remote for this repository first.', ready: false };
  if (s.behind) return { title: s.ahead ? 'Resolve the branch differences first' : 'Bring in remote changes first', detail: s.ahead ? 'This branch and the remote both have new commits. Finish merging or rebasing, test the result, then check again.' : 'The remote has newer commits. Pull them before pushing.', ready: false };
  if (!s.published) return { title: 'Ready to publish this branch', detail: 'Push after checking the committed changes. This creates the same branch on origin.', ready: true };
  if (s.ahead) return { title: `${s.ahead} commit${s.ahead === 1 ? '' : 's'} ready to push`, detail: 'Recommended once these changes are tested: push to back up and share the saved commits. No PR is needed just to upload them.', ready: true };
  return { title: 'Everything committed is uploaded', detail: s.dirty ? 'Your remaining edits are not committed. Finish and commit them before another push.' : 'Nothing to push. Come back after your next commit.', ready: false };
}
