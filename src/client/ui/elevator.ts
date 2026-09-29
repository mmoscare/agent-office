import type { FloorInfo, RepoChoice, ServerMsg } from '../../shared/protocol';
import { backOfficeFloors, floorNumber, floorPalette, mainFloors, normalizeRepo, sameRepo } from '../../shared/floors';
import { ROOF, ROOF_NAME } from '../../shared/rooftop';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, timeAgo, type Modal } from './dom';
import { localFloorPicker } from './local-floor';

// The elevator's panel: a button for every floor, plus opening a local folder or cloning a GitHub
// repository as a new floor. The first time
// the office runs there are no floors, and this is where you start. Floors filed in the Back Office
// wait in the basement: one "B" button below the main floors opens their own list.

export interface ElevatorOptions {
  net: Net;
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
  /** Showing the basement's Back Office list instead of the main floors. Opens there when you're on one of its floors. */
  let basement = !!store.currentFloor()?.backOffice;
  let openingLocal = false;
  let movingFloor = '';
  let managementKey = '';
  /** The search box and list are in place (rebuilding them would lose the focus mid-typing). */
  let built = false;

  const floorsEl = h('div.floors');
  const managementEl = h('div');
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
    openingLocal = busy;
    localTab.disabled = githubTab.disabled = busy;
    renderFloors();
  }, () => basement);
  const focusSource = () => source === 'local' ? local.focus() : input.focus();

  const needRepos = () => {
    const r = store.repos;
    if (r.loading || (r.at && Date.now() - r.at < REPOS_STALE_MS && !r.error)) return;
    store.repos = { ...r, loading: true };
    net.send({ t: 'floor.repos' });
  };

  /** What "Add floor" would add: the row picked, else what's typed if it's owner/name. */
  const choice = (): string | undefined => selected ?? normalizeRepo(filter);

  const floorButton = (f: FloorInfo) => {
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
      h('span.floor-no', { style: `background:${p.trim}` }, floorNumber(store.floors, f.id)),
      h('span.floor-text', {}, h('span.floor-name', {}, f.name, here ? h('span.here-tag', {}, 'you are here') : null), h('span.floor-sub', {}, f.repo ?? f.dir)),
      h('span.floor-stats', {}, ...stats.flatMap((s, j) => (j ? [' ', s] : [s]))),
    );
    btn.addEventListener('click', () => {
      if (here || f.cloning) return;
      modal.close();
      opts.ride(f.id);
    });
    return btn;
  };

  /** Project filing lives inside the Back Office, never beside the main floor buttons. */
  const manageFloors = () => {
    const available = store.floors.filter((f) => !f.cloning);
    if (!available.some((f) => f.id === movingFloor)) movingFloor = '';
    const select = h('select', { id: 'back-office-project', disabled: !!adding || openingLocal },
      h('option', { value: '' }, 'Choose a project…'),
      ...available.map((f) => h('option', { value: f.id }, `${floorNumber(store.floors, f.id)} · ${f.name}`)),
    );
    select.value = movingFloor;
    const move = h('button.btn', { type: 'button' });
    const update = () => {
      const floor = available.find((f) => f.id === movingFloor);
      move.disabled = !floor || !!adding || openingLocal;
      move.textContent = floor?.backOffice ? 'Move upstairs' : 'Move here';
    };
    select.addEventListener('change', () => { movingFloor = select.value; update(); });
    move.addEventListener('click', () => {
      const floor = store.floors.find((f) => f.id === movingFloor);
      if (floor && !floor.cloning) net.send({ t: 'floor.backOffice', floor: floor.id, on: !floor.backOffice });
    });
    update();
    return h('div.basement-manage', {}, h('label', { for: select.id }, 'Move an existing project'), h('div', {}, select, move));
  };

  /** The basement: the Back Office's floors, behind one button so the main list stays short. */
  const basementButton = (back: FloorInfo[]) => {
    const hereDown = back.some((f) => f.id === store.floor);
    const waiting = back.reduce((n, f) => n + f.waiting, 0);
    const btn = h(
      'button.floor-btn.basement',
      { type: 'button', disabled: !!adding || openingLocal, title: 'Down to the basement: projects filed in the Back Office' },
      h('span.floor-no', { style: 'background:#5c5f6e' }, 'B'),
      h(
        'span.floor-text',
        {},
        h('span.floor-name', {}, `Back Office (${back.length})`, hereDown ? h('span.here-tag', {}, 'you are down here') : null),
        h('span.floor-sub', {}, back.length ? back.map((f) => f.name).join(' · ') : 'Open to add or move projects here.'),
      ),
      h('span.floor-stats', {}, waiting ? h('span.waiting', { title: 'Waiting on someone' }, `🙋 ${waiting} `) : '', '⬇'),
    );
    btn.addEventListener('click', () => {
      basement = true;
      built = false;
      renderFloors();
      renderAdd();
    });
    return btn;
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
    const main = mainFloors(floors);
    const back = backOfficeFloors(floors);
    // People and worker counts refresh often; keep an open project picker in place during those updates.
    const key = basement ? JSON.stringify([!!adding, openingLocal, floors.map((f) => [f.id, f.name, f.backOffice, f.cloning])]) : '';
    if (key !== managementKey) {
      managementKey = key;
      managementEl.replaceChildren(...(basement ? [manageFloors()] : []));
    }
    if (basement) {
      const up = h('button.btn.basement-up', { type: 'button', disabled: !!adding || openingLocal }, '↑ back to the floors');
      up.addEventListener('click', () => {
        basement = false;
        built = false;
        renderFloors();
        renderAdd();
      });
      floorsEl.replaceChildren(
        h('div.basement-head', {}, up, h('span', {}, '🗄️ Back Office · basement')),
        ...(back.length ? back.map(floorButton) : [h('p.empty', {}, 'Nothing is filed in the Back Office yet.')]),
      );
      return;
    }
    floorsEl.replaceChildren(
      ...(floors.some((f) => !f.cloning) ? [roofButton()] : []),
      ...(main.length ? main.map(floorButton) : [h('p.empty', {}, back.length ? 'Every floor is filed in the Back Office.' : 'No floors yet.')]),
      ...(floors.length ? [basementButton(back)] : []),
    );
  };

  const repoRow = (r: RepoChoice) => {
    const floor = store.floors.find((f) => sameRepo(f.repo, r.name));
    const row = h(
      'div.repo',
      { role: 'option', class: selected && sameRepo(selected, r.name) ? 'sel' : '', 'aria-selected': String(!!selected && sameRepo(selected, r.name)), title: r.description ?? r.name },
      h('span.nm', {}, r.name),
      r.private ? h('span', { title: 'Private' }, '🔒') : null,
      h('span.desc', {}, r.description ?? ''),
      floor ? h('span.pill', {}, floor.id === store.floor ? 'you are here' : `floor ${floorNumber(store.floors, floor.id)}`) : r.pushedAt ? h('span.when', {}, timeAgo(r.pushedAt)) : null,
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
        addEl.replaceChildren(h('h3', {}, setup && !store.floors.length ? 'Open your first project' : basement ? 'Add a project to Back Office' : 'Add a project'), sourceChoice, local.element);
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
        h('h3', {}, setup && !store.floors.length ? 'Pick your first project' : basement ? 'Add a project to Back Office' : '➕ Add a project'),
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
    net.send({ t: 'floor.add', repo, backOffice: basement });
  };

  const onAdded = (msg: Extract<ServerMsg, { t: 'floor.added' }>) => {
    if (!adding || msg.repo !== adding) return;
    adding = null;
    localTab.disabled = githubTab.disabled = false;
    if (msg.error || !msg.floor) {
      error = msg.error ?? 'The floor could not be added';
      renderFloors();
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
    h('header', {}, h('h2', {}, setup ? '🏢 Welcome to Agent Office' : '🛗 Elevator'), close),
    h('div.body', {}, intro, floorsEl, managementEl, addEl),
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
