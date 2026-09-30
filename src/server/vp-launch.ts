// How go-live (vp-golive.ts) updates and restarts the running office, when it can: through the guided
// office update's launcher (src/server/office-update.ts and personal/windows/host.mjs, PR #84), which
// builds in a staging folder beside the live one and asks the Windows launcher for a restart. That
// module may not be in this build: it's looked for when go-live runs, and without it (or without a
// launcher that can restart the office) go-live hands the owner the manual steps instead.

/** A floor of the building, as the office update knows them. */
export interface LaunchFloor {
  name: string;
  dir: string;
}

export interface LaunchPrepared {
  ok: boolean;
  /** What happened, or why it stopped, in plain words. */
  message: string;
}

export type LaunchRestart = { restarting?: boolean; waiting?: boolean; confirm?: { name: string; floor: string; status: string }[] } | string;

/** Updating and restarting the office the safe way. */
export interface OfficeLauncher {
  /** Pulls the app folder, gets new packages and builds, all staged away from the live code. */
  prepare(log: (line: string) => void): Promise<LaunchPrepared>;
  /** 'idle': restart as soon as nobody's working; 'now': restart, but only with `confirm` when someone is. */
  restart(mode: 'idle' | 'now', confirm: boolean, by: string): Promise<LaunchRestart>;
  /** How the last restart for an update went, once the office is back: 'live' means it runs the new code. */
  verdict(): Promise<string | undefined>;
}

/** The shape of office-update.ts's updater that go-live relies on. */
interface Updater {
  state(floors: LaunchFloor[], admin: boolean, fresh?: boolean): Promise<UpdaterState | undefined>;
  pullApp(): Promise<{ ok: boolean; message: string }>;
  startPackages(): string | undefined;
  startBuild(): string | undefined;
  requestRestart(floors: LaunchFloor[], mode: 'now' | 'idle' | 'cancel', confirm: boolean, by: string): Promise<LaunchRestart>;
}

interface UpdaterState {
  packages?: { needed?: boolean; staged?: boolean };
  build?: { state?: string; tail?: string };
  restart?: { available?: boolean; reason?: string; needsPackagesByHand?: boolean };
  last?: { verdict?: string; message?: string };
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isUpdater(u: unknown): u is Updater {
  const x = u as Partial<Record<keyof Updater, unknown>> | undefined;
  return !!x && ['state', 'pullApp', 'startPackages', 'startBuild', 'requestRestart'].every((k) => typeof x[k as keyof Updater] === 'function');
}

/** Wraps an updater (the real one, or a test's) as go-live's launcher. */
export function launcherFrom(u: Updater, floors: () => LaunchFloor[], pollMs = 3000, maxMs = 45 * 60_000): OfficeLauncher {
  const state = () => u.state(floors(), true, true);
  const until = async (done: (s: UpdaterState) => boolean): Promise<UpdaterState | undefined> => {
    const end = Date.now() + maxMs;
    for (;;) {
      const s = await state();
      if (!s || done(s) || Date.now() > end) return s;
      await sleep(pollMs);
    }
  };
  return {
    async prepare(log) {
      const pulled = await u.pullApp();
      log(`⬇️ App folder: ${pulled.message}`);
      if (!pulled.ok) return { ok: false, message: pulled.message };
      let s = await state();
      if (s?.restart?.needsPackagesByHand) return { ok: false, message: 'New packages can only go in with the office stopped: that restart is the owner\'s' };
      if (s?.packages?.needed && !s.packages.staged) {
        const err = u.startPackages();
        if (err) return { ok: false, message: err };
        log('📦 Installing the new packages in the staging copy');
        s = await until((x) => x.build?.state !== 'packages');
        if (!s?.packages?.staged) return { ok: false, message: `The new packages didn't install: ${s?.build?.tail ?? s?.error ?? 'no word why'}` };
      }
      const err = u.startBuild();
      if (err) return { ok: false, message: err };
      log('🔨 Building in the staging copy (the live build is untouched)');
      s = await until((x) => x.build?.state === 'ready' || x.build?.state === 'failed');
      if (s?.build?.state !== 'ready') return { ok: false, message: `The build didn't finish: ${s?.build?.tail?.split('\n').slice(-5).join(' ') ?? s?.error ?? 'it timed out'}` };
      return { ok: true, message: 'Pulled, built and staged: ready to restart' };
    },
    restart: (mode, confirm, by) => u.requestRestart(floors(), mode, confirm, by),
    async verdict() {
      return (await state())?.last?.verdict;
    },
  };
}

/**
 * The office's launcher, when this build has the guided update and runs under a launcher that can
 * start it again; undefined otherwise (then the restart is the owner's, by hand).
 */
export async function officeLauncher(floors: () => LaunchFloor[]): Promise<OfficeLauncher | undefined> {
  // A name, not a literal: this build may not have the module, and that's fine.
  const spec = './office-update.js';
  let mod: { officeUpdater?: () => unknown } | undefined;
  try {
    mod = (await import(spec)) as { officeUpdater?: () => unknown };
  } catch {
    return undefined;
  }
  const u = mod?.officeUpdater?.();
  if (!isUpdater(u)) return undefined;
  const s = await u.state(floors(), true).catch(() => undefined);
  if (!s?.restart?.available) return undefined;
  return launcherFrom(u, floors);
}
