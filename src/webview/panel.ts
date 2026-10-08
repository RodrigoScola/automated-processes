import type { PanelHostMessage, PanelMessage, PanelState, PanelTab, Scope } from '../shared/panelProtocol';
import {
	databaseDraft,
	databaseForm,
	draftToScript,
	emptyStep,
	emptyStream,
	initialScope,
	migrationsDraft,
	PanelUi,
	matchingIcons,
	renderIconGrid,
	renderPanel,
	scriptDraft,
	serverDraft,
} from './panelRender';

interface VsCodeApi {
	postMessage(message: PanelMessage): void;
	getState(): { migrationsOpen?: boolean } | undefined;
	setState(state: { migrationsOpen?: boolean }): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();
const root = document.getElementById('app') as HTMLElement;
let state: PanelState | undefined;
/** The scope buttons were used; incoming state no longer picks the scope. */
let scopeChosen = false;
const ui: PanelUi = {
	tab: (document.body.dataset.tab as PanelTab | undefined) ?? 'database',
	scope: { database: 'local', servers: 'local', scripts: 'local' },
	db: { engine: 'auto', source: 'envFile', envFile: '', urlVariable: '', url: '', runsIn: 'local', dockerName: '', sqliteFolder: '', mainBranches: '' },
	dbDirty: false,
	migrations: { command: '', cwd: '', onBranchChange: 'ask', afterCopy: true, streams: [] },
	migrationsDirty: false,
	iconSearch: '',
	migrationsOpen: api.getState()?.migrationsOpen,
};

function post(message: PanelMessage): void {
	api.postMessage(message);
}

function scope(): Scope {
	return ui.scope[ui.tab];
}

function render(): void {
	const focused = document.activeElement as HTMLElement | null;
	const focusKey = focused?.dataset.bind;
	root.innerHTML = renderPanel(state, ui);
	const restore = focusKey ? root.querySelector<HTMLElement>(`[data-bind="${CSS.escape(focusKey)}"]`) : root.querySelector<HTMLElement>('[data-autofocus]');
	restore?.focus();
}

// ── Binding inputs to drafts (`data-bind="editing.draft.steps.0.run"`) ──────

function setPath(path: string, value: unknown): void {
	const keys = path.split('.');
	let target: Record<string, unknown> = ui as unknown as Record<string, unknown>;
	for (const key of keys.slice(0, -1)) {
		target = target[key] as Record<string, unknown>;
		if (!target) {
			return;
		}
	}
	target[keys[keys.length - 1]] = value;
}

function valueOf(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): unknown {
	return element instanceof HTMLInputElement && element.type === 'checkbox' ? element.checked : element.value;
}

function bind(event: Event, rerender: boolean): void {
	const element = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
	const path = element.dataset?.bind;
	if (!path) {
		return;
	}
	if (element instanceof HTMLInputElement && element.type === 'radio' && !element.checked) {
		return;
	}
	setPath(path, valueOf(element));
	if (path.startsWith('db.')) {
		ui.dbDirty = true;
	} else if (path.startsWith('migrations.')) {
		ui.migrationsDirty = true;
	}
	// Selects, radios and checkboxes change which fields show; text keeps focus while typing.
	if (rerender) {
		render();
	}
}

root.addEventListener('input', (event) => {
	const element = event.target as HTMLElement;
	bind(event, false);
	// Searching icons redraws only the grid, so the search box keeps focus and caret.
	if (element.dataset.bind === 'iconSearch' && state && ui.editing?.kind === 'script') {
		const grid = root.querySelector('.icon-grid');
		if (grid) {
			grid.innerHTML = renderIconGrid(state.icons, ui.iconSearch, ui.editing.draft.icon);
		}
	}
});

root.addEventListener('change', (event) => {
	const element = event.target as HTMLInputElement;
	if (element.dataset.action === 'include-launch') {
		post({ type: 'setIncludeLaunch', value: element.checked, scope: ui.scope.servers });
		return;
	}
	if (element.dataset.action === 'pick' && ui.suggestions) {
		const id = element.dataset.id ?? '';
		ui.suggestions.picked = element.checked ? [...ui.suggestions.picked, id] : ui.suggestions.picked.filter((item) => item !== id);
		render();
		return;
	}
	bind(event, element.tagName === 'SELECT' || element.type === 'radio' || element.type === 'checkbox');
});

// ── Actions ──────────────────────────────────────────────────────────────────

root.addEventListener('click', (event) => {
	const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
	if (!target || target.hasAttribute('disabled') || target.dataset.action === 'include-launch' || target.dataset.action === 'pick') {
		return;
	}
	event.preventDefault();
	act(target.dataset.action ?? '', target.dataset);
});

root.addEventListener('keydown', (event) => {
	// Enter in a single-line field saves the form it's in.
	const element = event.target as HTMLElement;
	if (element.dataset.bind === 'iconSearch' && (event.key === 'Enter' || event.key === 'Escape')) {
		// Enter picks the first match; Escape closes the picker (not the form).
		event.preventDefault();
		const first = state ? matchingIcons(state.icons, ui.iconSearch)[0] : undefined;
		act(event.key === 'Enter' && first ? 'pick-icon' : 'icon-toggle', { id: first });
		return;
	}
	if (event.key === 'Enter' && element instanceof HTMLInputElement && element.type !== 'checkbox' && element.type !== 'radio') {
		const form = element.closest<HTMLElement>('[data-form]')?.dataset.form;
		const bound = element.dataset.bind ?? '';
		act(form === 'script' ? 'save-script' : form === 'server' ? 'save-server' : bound.startsWith('migrations.') ? 'save-migrations' : bound.startsWith('db.') ? 'save-db' : '', {});
	} else if (event.key === 'Escape' && ui.editing) {
		act('cancel', {});
	}
});

function act(action: string, data: DOMStringMap): void {
	if (!state) {
		return;
	}
	const editing = ui.editing;
	switch (action) {
		case 'tab':
			ui.tab = (data.id as PanelTab) ?? 'database';
			ui.notice = undefined;
			break;
		case 'scope':
			ui.scope[ui.tab] = data.id === 'global' ? 'global' : 'local';
			scopeChosen = true;
			break;
		case 'reset':
			post({ type: 'reset', tab: data.id as PanelTab });
			return;
		case 'save-db':
			post({ type: 'saveDatabase', form: databaseForm(ui.db), scope: ui.scope.database });
			return;
		case 'test-db':
			post({ type: 'testConnection' });
			ui.notice = { tab: 'database', kind: 'ok', message: 'Connecting…' };
			break;
		case 'discard-db':
			ui.db = databaseDraft(state);
			ui.dbDirty = false;
			ui.notice = undefined;
			break;
		case 'detect':
			post({ type: 'detect', tab: data.id === 'scripts' ? 'scripts' : 'servers' });
			ui.notice = undefined;
			return;
		case 'add-suggestions':
			if (ui.suggestions) {
				post({ type: 'addSuggestions', ids: ui.suggestions.picked, tab: ui.suggestions.tab, scope: ui.scope[ui.suggestions.tab] });
			}
			return;
		case 'close-suggestions':
			ui.suggestions = undefined;
			break;
		case 'add-server':
			ui.editing = { kind: 'server', draft: serverDraft() };
			ui.notice = undefined;
			break;
		case 'edit-server': {
			const server = state.servers.find((item) => item.id === data.id);
			// A launch.json-only server isn't configured yet: saving adds one for it.
			ui.editing = { kind: 'server', originalId: server?.source === 'launch' ? undefined : server?.id, draft: serverDraft(server) };
			ui.notice = undefined;
			break;
		}
		case 'delete-server':
			post({ type: 'deleteServer', id: data.id ?? '', scope: scope() });
			return;
		case 'save-server':
			if (editing?.kind === 'server') {
				post({ type: 'saveServer', originalId: editing.originalId, server: editing.draft, scope: scope() });
			}
			return;
		case 'add-launch':
			post({ type: 'addLaunch', name: data.id ?? '', scope: ui.scope.servers });
			return;
		case 'open-launch':
			post({ type: 'open', target: 'launchJson' });
			return;
		case 'add-script':
			ui.editing = { kind: 'script', draft: scriptDraft() };
			ui.notice = undefined;
			break;
		case 'edit-script': {
			const script = state.scripts.find((item) => item.id === data.id);
			ui.editing = { kind: 'script', originalId: script?.id, draft: scriptDraft(script) };
			ui.notice = undefined;
			break;
		}
		case 'delete-script':
			post({ type: 'deleteScript', id: data.id ?? '', scope: scope() });
			return;
		case 'move-script':
			post({ type: 'moveScript', id: data.id ?? '', delta: data.delta === '-1' ? -1 : 1, scope: scope() });
			return;
		case 'save-script':
			if (editing?.kind === 'script') {
				post({ type: 'saveScript', originalId: editing.originalId, script: draftToScript(editing.draft, editing.originalId), scope: scope() });
			}
			return;
		case 'icon-toggle':
			ui.iconPicker = !ui.iconPicker;
			ui.iconSearch = '';
			break;
		case 'pick-icon':
			if (editing?.kind === 'script' && data.id) {
				editing.draft.icon = data.id;
			}
			ui.iconPicker = false;
			ui.iconSearch = '';
			break;
		case 'add-step':
			if (editing?.kind === 'script') {
				editing.draft.steps.push(emptyStep());
			}
			break;
		case 'remove-step':
			if (editing?.kind === 'script') {
				editing.draft.steps.splice(Number(data.index), 1);
			}
			break;
		case 'move-step':
			if (editing?.kind === 'script') {
				move(editing.draft.steps, Number(data.index), Number(data.delta));
			}
			break;
		case 'add-stream':
			ui.migrations.streams.push(emptyStream());
			ui.migrationsDirty = true;
			break;
		case 'remove-stream':
			ui.migrations.streams.splice(Number(data.index), 1);
			ui.migrationsDirty = true;
			break;
		case 'migrations-open':
		case 'migrations-close':
			ui.migrationsOpen = action === 'migrations-open';
			// Remembered when the panel is closed and opened again.
			api.setState({ migrationsOpen: ui.migrationsOpen });
			break;
		case 'remove-migrations':
			post({ type: 'removeMigrations', scope: ui.scope.scripts });
			return;
		case 'save-migrations':
			post({ type: 'saveMigrations', migrations: ui.migrations, scope: ui.scope.scripts });
			return;
		case 'discard-migrations':
			ui.migrations = migrationsDraft(state);
			ui.migrationsDirty = false;
			ui.notice = undefined;
			break;
		case 'cancel':
			ui.iconPicker = false;
			ui.editing = undefined;
			ui.notice = undefined;
			break;
		default:
			return;
	}
	render();
}

function move<T>(items: T[], index: number, delta: number): void {
	const target = index + delta;
	if (target >= 0 && target < items.length) {
		[items[index], items[target]] = [items[target], items[index]];
	}
}

// ── From the extension ───────────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent<PanelHostMessage>) => {
	const message = event.data;
	if (message?.type === 'state') {
		state = message.state;
		if (!ui.dbDirty) {
			ui.db = databaseDraft(state);
		}
		if (!ui.migrationsDirty) {
			ui.migrations = migrationsDraft(state);
		}
		if (!scopeChosen) {
			ui.scope = initialScope(state);
		}
	} else if (message?.type === 'show') {
		ui.tab = message.tab;
	} else if (message?.type === 'suggestions') {
		// New ones are ticked; ones already there aren't.
		ui.suggestions = message.suggestions.length
			? { tab: message.tab, items: message.suggestions, picked: message.suggestions.filter((item) => !item.exists).map((item) => item.id) }
			: undefined;
	} else if (message?.type === 'notice') {
		ui.notice = message.notice;
		if (message.saved) {
			if (message.notice.tab === 'database') {
				ui.dbDirty = false;
				if (state) {
					ui.db = databaseDraft(state);
				}
			} else if (message.notice.area === 'migrations') {
				ui.migrationsDirty = false;
				if (state) {
					ui.migrations = migrationsDraft(state);
				}
			} else {
				ui.editing = undefined;
			}
		}
	}
	render();
});

render();
post({ type: 'ready' });
