import type { FloorInfo, RepoChoice, ServerMsg } from '../../shared/protocol';
import { floorPalette, normalizeRepo, sameRepo, type FloorSection } from '../../shared/floors';
import { ROOF, ROOF_NAME } from '../../shared/rooftop';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, timeAgo, toast, type Modal } from './dom';
import { localFloorPicker } from './local-floor';

// The elevator's panel: a button for every floor, plus opening a local folder or cloning a GitHub
// repository as a new floor. The first time
// the office runs there are no floors, and this is where you start.

export interface ElevatorOptions {
  net: Net;
  section?: FloorSection;
  ride(floorId: string): void;
}

/** How many repositories the list shows at once; typing narrows it down. */
const SHOWN = 60;
/** Ask gh for the repositories again after this long. */
const REPOS_STALE_MS = 5 * 60_000;

const addedWaiters = new Set<(msg: Extract<ServerMsg, { t: 'floor.added' }>) => void>();

/** Main feeds server messages through here, so a panel waiting on its clone hears back. */
export function routeElevatorMessage(msg: ServerMsg) {
  if (msg.t === 'floor.added') for (const fn of addedWaiters) fn(msg);
}

let current: Modal | null = null;

export function elevatorPanelOpen(): boolean {
  return !!current;
}

export function openElevator(opts: ElevatorOptions): void {
  if (current) return;
  // Nowhere to go yet: the panel stays until there's a floor to ride to.
  const setup = !store.floor;
  const { net } = opts;
  let filter = '';
  let selected: string | null = null;
  let adding: string | null = null;
  let error = '';
  let showAdd = setup || !store.floors.length;
  let source: 'local' | 'github' = 'local';
  let section: FloorSection = opts.section ?? 'main';
  let localBusy = false;
  const moving = new Set<string>();
  /** The search box and list are in place (rebuilding them would lose the focus mid-typing). */
  let built = false;

  const floorsEl = h('div.floors');
  const title = h('h2');
  const back = h('button.btn', { type: 'button' }, '← Main floors');
  back.addEventListener('click', () => setSection('main'));
  const addEl = h('div.add');
  const input = h('input', { type: 'text', placeholder: 'Search your repositories, or type owner/name', 'aria-label': 'Repository', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const listEl = h('div.repo-list', { role: 'listbox', 'aria-label': 'Repositories' });
  const statusEl = h('div');
  const addBtn = h('button.btn.primary', { type: 'button' }, '🛗 Add floor');
  const refreshBtn = h('button.btn', { type: 'button', title: 'Ask GitHub for the list again' }, '↻');
  const close = setup ? null : h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const localTab = h('button.btn', { type: 'button', 'aria-pressed': 'true' }, 'Local folder');
  const githubTab = h('button.btn', { type: 'button', 'aria-pressed': 'false' }, 'Clone from GitHub');
  const sourceChoice = h('div.floor-source', { role: 'group', 'aria-label': 'Project source' }, localTab, githubTab);
  const local = localFloorPicker((floor) => { modal.close(); opts.ride(floor); }, (busy) => {
    localBusy = busy;
    localTab.disabled = githubTab.disabled = busy;
    renderFloors();
  }, () => section);
  const focusSource = () => source === 'local' ? local.focus() : input.focus();

  const needRepos = () => {
    const r = store.repos;
    if (r.loading || (r.at && Date.now() - r.at < REPOS_STALE_MS && !r.error)) return;
    store.repos = { ...r, loading: true };
    net.send({ t: 'floor.repos' });
  };

  /** What "Add floor" would add: the row picked, else what's typed if it's owner/name. */
  const choice = (): string | undefined => selected ?? normalizeRepo(filter);

  const floorButton = (f: FloorInfo, i: number) => {
    const here = f.id === store.floor;
    const p = floorPalette(f.palette);
    const stats: (HTMLElement | string)[] = [];
    if (f.cloning) stats.push('⏳ Cloning…');
    else {
      if (f.busy) stats.push(h('span', { title: 'Working' }, `👷 ${f.busy}`));
      if (f.waiting) stats.push(h('span.waiting', { title: 'Waiting on someone' }, `🙋 ${f.waiting}`));
      stats.push(h('span', { title: 'Workers at desks' }, `💻 ${f.workers}`));
      if (f.people) stats.push(h('span', { title: 'People on this floor' }, `🧑 ${f.people}`));
    }
    const btn = h(
      'button.floor-btn',
      { type: 'button', class: here ? 'here' : '', disabled: f.cloning || here, title: here ? "You're on this floor" : f.cloning ? 'Still being cloned' : `Ride to ${f.name}` },
      h('span.floor-no', { style: `background:${p.trim}` }, String(i + 1)),
      h('span.floor-text', {}, h('span.floor-name', {}, f.name, here ? h('span.here-tag', {}, 'you are here') : null), h('span.floor-sub', {}, f.repo ?? f.dir)),
      h('span.floor-stats', {}, ...stats.flatMap((s, j) => (j ? [' ', s] : [s]))),
    );
    btn.addEventListener('click', () => {
      if (here || f.cloning) return;
      modal.close();
      opts.ride(f.id);
    });
    const destination = f.section === 'backoffice' ? 'main' : 'backoffice';
    const label = destination === 'main' ? 'Move to main floors' : 'Move to Backoffice';
    const move = h('button.btn.floor-move', { type: 'button', disabled: f.cloning || moving.has(f.id), 'aria-label': `${label}: ${f.name}`, title: label }, destination === 'main' ? '↑ Main' : '↓ Backoffice');
    move.addEventListener('click', async () => {
      if (moving.has(f.id)) return;
      moving.add(f.id);
      move.disabled = true;
      try {
        const response = await fetch('/api/floors/section', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ floor: f.id, section: destination }) });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error ?? 'Could not move the project');
      } catch (err) {
        toast((err as Error).message, 'error');
      } finally {
        moving.delete(f.id);
        if (current === modal) renderFloors();
      }
    });
    return h('div.floor-entry', {}, btn, move);
  };

  /** The roof, over every floor: the rooftop bar. */
  const roofButton = () => {
    const here = store.floor === ROOF;
    const people = [...store.peers.values()].filter((p) => p.floor === ROOF).length;
    const btn = h(
      'button.floor-btn',
      { type: 'button', class: here ? 'here' : '', disabled: here, title: here ? "You're up on the roof" : `Ride up to the ${ROOF_NAME.toLowerCase()}` },
      h('span.floor-no', { style: 'background:#2b2d42' }, '🍸'),
      h('span.floor-text', {}, h('span.floor-name', {}, ROOF_NAME, here ? h('span.here-tag', {}, 'you are here') : null), h('span.floor-sub', {}, 'The roof: a DJ playing drum and bass, a bar, and the city all around')),
      h('span.floor-stats', {}, people ? h('span', { title: 'People up there' }, `🧑 ${people}`) : ''),
    );
    btn.addEventListener('click', () => {
      if (here) return;
      modal.close();
      opts.ride(ROOF);
    });
    return btn;
  };

  const renderFloors = () => {
    const floors = store.floors;
    title.textContent = section === 'backoffice' ? 'B · Backoffice' : setup ? '🏢 Welcome to Agent Office' : '🛗 Elevator';
    back.disabled = !!adding || localBusy;
    const visible = floors.filter(f => (f.section ?? 'main') === section);
    const basement = floors.filter(f => f.section === 'backoffice');
    const basementButton = h('button.floor-btn', { type: 'button', disabled: !!adding || localBusy, 'aria-label': 'Basement: Backoffice' },
      h('span.floor-no', { style: 'background:#3d5a80' }, 'B'),
      h('span.floor-text', {}, h('span.floor-name', {}, 'Backoffice', basement.some(f => f.id === store.floor) ? h('span.here-tag', {}, 'you are here') : null), h('span.floor-sub', {}, `Basement · ${basement.length} project${basement.length === 1 ? '' : 's'} · Open repository menu`)),
      h('span.floor-stats', {}, '→'),
    );
    basementButton.addEventListener('click', () => setSection('backoffice'));
    floorsEl.replaceChildren(
      ...(section === 'backoffice' ? [back, h('p.note', {}, 'Basement projects. Open a repository below, or add a local folder or GitHub repository.')] : floors.some(f => !f.cloning) ? [roofButton()] : []),
      ...(visible.length ? visible.map(f => floorButton(f, floors.indexOf(f))) : [h('p.empty', {}, section === 'backoffice' ? 'No Backoffice projects yet. Add a project below or move one here from the main floors.' : 'No main floors yet.')]),
      ...(section === 'main' ? [basementButton] : []),
    );
  };

  const setSection = (next: FloorSection) => {
    if (adding || localBusy) return;
    section = next;
    showAdd = false;
    built = false;
    error = '';
    renderFloors();
    renderAdd();
    (next === 'backoffice' ? back : floorsEl.querySelector<HTMLButtonElement>('[aria-label="Basement: Backoffice"]'))?.focus();
  };

  const repoRow = (r: RepoChoice) => {
    const floor = store.floors.find((f) => sameRepo(f.repo, r.name));
    const row = h(
      'div.repo',
      { role: 'option', class: selected && sameRepo(selected, r.name) ? 'sel' : '', 'aria-selected': String(!!selected && sameRepo(selected, r.name)), title: r.description ?? r.name },
      h('span.nm', {}, r.name),
      r.private ? h('span', { title: 'Private' }, '🔒') : null,
      h('span.desc', {}, r.description ?? ''),
      floor ? h('span.pill', {}, floor.id === store.floor ? 'you are here' : `${floor.section === 'backoffice' ? 'Backoffice · ' : ''}floor ${store.floors.indexOf(floor) + 1}`) : r.pushedAt ? h('span.when', {}, timeAgo(r.pushedAt)) : null,
    );
    row.addEventListener('click', () => {
      if (adding) return;
      if (floor) {
        // Already a floor: the button takes you there.
        if (floor.id !== store.floor && !floor.cloning) {
          modal.close();
          opts.ride(floor.id);
        }
        return;
      }
      selected = r.name;
      renderAdd();
    });
    row.addEventListener('dblclick', () => {
      if (!floor) add(r.name);
    });
    return row;
  };

  const renderAdd = () => {
    local.button.classList.toggle('hidden', !showAdd || source !== 'local');
    if (!showAdd) {
      const open = h('button.btn', { type: 'button' }, '➕ Add a project');
      open.addEventListener('click', () => {
        showAdd = true;
        if (source === 'github') needRepos();
        renderAdd();
        setTimeout(focusSource, 0);
      });
      addEl.replaceChildren(open);
      addBtn.classList.add('hidden');
      return;
    }
    localTab.setAttribute('aria-pressed', String(source === 'local'));
    githubTab.setAttribute('aria-pressed', String(source === 'github'));
    addBtn.classList.toggle('hidden', source !== 'github');
    if (source === 'local') {
      if (!built) {
        built = true;
        addEl.replaceChildren(h('h3', {}, setup && !store.floors.length ? 'Open your first project' : 'Add a project'), sourceChoice, local.element);
      }
      return;
    }
    addBtn.classList.remove('hidden');
    const r = store.repos;
    const q = filter.trim().toLowerCase();
    const typed = normalizeRepo(filter);
    const matches = r.list.filter((x) => !q || x.name.toLowerCase().includes(q) || (x.description ?? '').toLowerCase().includes(q));
    const rows: HTMLElement[] = [];
    // owner/name that isn't in the list (someone else's public repository): offer it anyway.
    if (typed && !r.list.some((x) => sameRepo(x.name, typed))) rows.push(repoRow({ name: typed, private: false, description: 'Not in your list — the office will try to clone it' }));
    rows.push(...matches.slice(0, SHOWN).map(repoRow));
    if (!rows.length) rows.push(h('p.empty', { style: 'padding:10px' }, r.loading ? 'Asking GitHub for your repositories…' : r.error ? '' : q ? 'Nothing matches. Type owner/name to clone any repository.' : 'No repositories.'));
    if (matches.length > SHOWN) rows.push(h('p.empty', { style: 'padding:8px 10px' }, `…and ${matches.length - SHOWN} more — type to narrow it down`));
    listEl.replaceChildren(...rows);
    const pick = choice();
    const dest = pick ? `${store.projectsDir.dir}/${pick}` : `${store.projectsDir.dir}/<owner>/<repo>`;
    statusEl.replaceChildren(
      adding
        ? h('p.note.busy', {}, `⏳ Cloning ${adding} into ${store.projectsDir.dir}/${adding}… A big repository can take a minute.`)
        : h('p.note', {}, `Cloned into ${dest} with this machine's gh login. Everything on the new floor works in that checkout.${store.me.admin ? ' Pick another folder in ⚙️ Settings.' : ''}`),
      ...[r.error, error].filter(Boolean).map((e) => h('p.err', {}, e)),
    );
    addBtn.disabled = !!adding || !pick || store.floors.some((f) => sameRepo(f.repo, pick));
    addBtn.textContent = adding ? '⏳ Cloning…' : pick ? `🛗 Add ${pick}` : '🛗 Add floor';
    input.disabled = !!adding;
    if (!built) {
      built = true;
      addEl.replaceChildren(
        h('h3', {}, setup && !store.floors.length ? 'Pick your first project' : '➕ Add a project'),
        sourceChoice,
        h('div.repo-search', {}, input, refreshBtn),
        listEl,
        statusEl,
      );
    }
  };

  const add = (repo: string) => {
    if (adding) return;
    adding = repo;
    localTab.disabled = githubTab.disabled = true;
    error = '';
    renderFloors();
    renderAdd();
    net.send({ t: 'floor.add', repo, section });
  };

  const onAdded = (msg: Extract<ServerMsg, { t: 'floor.added' }>) => {
    if (!adding || msg.repo !== adding) return;
    adding = null;
    localTab.disabled = githubTab.disabled = false;
    renderFloors();
    if (msg.error || !msg.floor) {
      error = msg.error ?? 'The floor could not be added';
      renderAdd();
      return;
    }
    modal.close();
    opts.ride(msg.floor);
  };
  addedWaiters.add(onAdded);

  input.addEventListener('input', () => {
    filter = input.value;
    // Typing something else drops the row that was picked, unless it's still what's typed.
    if (selected && !sameRepo(selected, normalizeRepo(filter))) selected = null;
    renderAdd();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const q = filter.trim().toLowerCase();
    const matches = store.repos.list.filter((x) => !store.floors.some((f) => sameRepo(f.repo, x.name)) && (x.name.toLowerCase().includes(q) || (x.description ?? '').toLowerCase().includes(q)));
    const pick = choice() ?? (q && matches.length === 1 ? matches[0].name : undefined);
    if (pick) add(pick);
  });
  addBtn.addEventListener('click', () => {
    const pick = choice();
    if (pick) add(pick);
  });
  refreshBtn.addEventListener('click', () => {
    store.repos = { ...store.repos, loading: true, error: undefined };
    renderAdd();
    net.send({ t: 'floor.repos', refresh: true });
  });
  const setSource = (next: typeof source) => {
    if (source === next) return;
    source = next;
    built = false;
    if (source === 'github') needRepos();
    renderAdd();
    focusSource();
  };
  localTab.addEventListener('click', () => setSource('local'));
  githubTab.addEventListener('click', () => setSource('github'));

  const intro = setup
    ? h(
        'p.intro',
        {},
        store.floors.length
          ? 'Every project is a floor of this building. Pick a floor to ride to, or add another project.'
          : 'Every project is a floor of this building. Open a folder on this computer or clone a GitHub repository to create your first floor.',
      )
    : null;
  const el = h(
    'div.modal.elevator',
    { role: 'dialog', 'aria-label': 'Elevator' },
    h('header', {}, title, close),
    h('div.body', {}, intro, floorsEl, addEl),
    h('footer', {}, h('span.grow', {}, setup ? 'Your office, one floor per project' : 'Pick a floor · Esc to stay here'), local.button, addBtn),
  );
  const unsubs = [store.on('floors', () => (renderFloors(), renderAdd())), store.on('repos', renderAdd), store.on('projectsDir', renderAdd), store.on('floor', renderFloors), store.on('peers', renderFloors)];
  const modal = openModal(el, {
    doing: '🛗 at the elevator',
    escCloses: !setup,
    backdropCloses: !setup,
    onClose: () => {
      current = null;
      addedWaiters.delete(onAdded);
      local.dispose();
      for (const off of unsubs) off();
    },
  });
  current = modal;
  close?.addEventListener('click', () => modal.close());
  renderFloors();
  renderAdd();
  if (showAdd) setTimeout(focusSource, 30);
}
