// ✨ What's new, on the queue staffer's clipboard: every change that landed on a floor's working
// branch, in plain words for someone who doesn't program (see server/change-notes.ts).

/** How many changes the clipboard asks for at first, and how many more each "Show older" adds. */
export const WHATS_NEW_PAGE = 40;
/** The most it ever asks for at once. */
export const WHATS_NEW_MAX = 5000;

/** One change on the floor's working branch. */
export interface ChangeNote {
  /** Its own for good: `pr:12` or `commit:<sha>`, after `owner/name ` on a floor of several repositories. */
  key: string;
  /** When it landed (ms). */
  at: number;
  /** What it means for the person using the app, in plain words; or, until then, its title tidied up. */
  text: string;
  /** False while `text` is only the title tidied up, not yet rewritten in plain words. */
  plain: boolean;
  /** The title its developer gave it, as written. */
  title: string;
  /** The original author's updates, brought in. */
  author?: boolean;
  /** The pull request (or the commit) on GitHub, for whoever wants the details. */
  url?: string;
  /** Which repository, on a floor of several. */
  repo?: string;
}

export interface WhatsNew {
  floor: string;
  /** The branch the changes landed on, when the floor is one repository. */
  branch?: string;
  /** Newest first: the first `show` of `total`. */
  notes: ChangeNote[];
  total: number;
  /** Being put in plain words right now: ask again shortly for them. */
  writing: number;
  /** Still being brought up to date from GitHub: ask again shortly. */
  refreshing: boolean;
  /** Why nothing is being put in plain words, when that's so. */
  writer?: string;
  /** Why the list couldn't be read (or read only in part). */
  error?: string;
}
