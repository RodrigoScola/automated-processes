import type { PanelHostMessage, PanelMessage, PanelState, PanelTab } from '../shared/panelProtocol';
import {
	databaseDraft,
	databaseForm,
	draftToScript,
	emptyStep,
	PanelUi,
	renderPanel,
	scriptDraft,
	serverDraft,
	StepDraft,
} from './panelRender';

interface VsCodeApi {
	postMessage(message: PanelMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();
const root = document.getElementById('app') as HTMLElement;
let state: PanelState | undefined;
const ui: PanelUi = {
	tab: (document.body.dataset.tab as PanelTab | undefined) ?? 'database',
	db: { engine: 'auto', source: 'envFile', envFile: '', urlVariable: '', url: '', runsIn: 'local', dockerName: '', sqliteFolder: '', mainBranches: '' },
	dbDirty: false,
};

function post(message: PanelMessage): void {
	api.postMessage(message);
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
	}
	// Selects, radios and checkboxes change which fields show; text keeps focus while typing.
	if (rerender) {
		render();
	}
}

root.addEventListener('input', (event) => {
	const element = event.target as HTMLElement;
	bind(event, false);
	// The icon preview follows the name.
	if (element.dataset.bind === 'editing.draft.icon') {
		const preview = element.parentElement?.querySelector('.codicon');
		if (preview) {
			preview.className = `codicon codicon-${(element as HTMLInputElement).value.trim() || 'play'}`;
		}
	}
});
root.addEventListener('change', (event) => {
	const element = event.target as HTMLInputElement;
	if (element.dataset.action === 'include-launch') {
		post({ type: 'setIncludeLaunch', value: element.checked });
		return;
	}
	bind(event, element.tagName === 'SELECT' || element.type === 'radio' || element.type === 'checkbox');
});

// ── Actions ──────────────────────────────────────────────────────────────────

root.addEventListener('click', (event) => {
	const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
	if (!target || target.hasAttribute('disabled') || target.dataset.action === 'include-launch') {
		return;
	}
	event.preventDefault();
	act(target.dataset.action ?? '', target.dataset);
});

root.addEventListener('keydown', (event) => {
	// Enter in a single-line field saves the form it's in.
	const element = event.target as HTMLElement;
	if (event.key === 'Enter' && element instanceof HTMLInputElement && element.type !== 'checkbox' && element.type !== 'radio') {
		const form = element.closest<HTMLElement>('[data-form]')?.dataset.form;
		act(form === 'script' ? 'save-script' : form === 'server' ? 'save-server' : ui.tab === 'database' ? 'save-db' : '', {});
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
		case 'save-db':
			post({ type: 'saveDatabase', form: databaseForm(ui.db) });
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
		case 'reset':
			post({ type: 'reset', tab: data.id as PanelTab });
			return;
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
			post({ type: 'deleteServer', id: data.id ?? '' });
			return;
		case 'save-server':
			if (editing?.kind === 'server') {
				post({ type: 'saveServer', originalId: editing.originalId, server: editing.draft });
			}
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
			post({ type: 'deleteScript', id: data.id ?? '' });
			return;
		case 'move-script':
			post({ type: 'moveScript', id: data.id ?? '', delta: data.delta === '-1' ? -1 : 1 });
			return;
		case 'save-script':
			if (editing?.kind === 'script') {
				post({ type: 'saveScript', originalId: editing.originalId, script: draftToScript(editing.draft, editing.originalId) });
			}
			return;
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
				moveStep(editing.draft.steps, Number(data.index), Number(data.delta));
			}
			break;
		case 'cancel':
			ui.editing = undefined;
			ui.notice = undefined;
			break;
		default:
			return;
	}
	render();
}

function moveStep(steps: StepDraft[], index: number, delta: number): void {
	const target = index + delta;
	if (target >= 0 && target < steps.length) {
		[steps[index], steps[target]] = [steps[target], steps[index]];
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
	} else if (message?.type === 'show') {
		ui.tab = message.tab;
	} else if (message?.type === 'notice') {
		ui.notice = message.notice;
		if (message.saved) {
			if (message.notice.tab === 'database') {
				ui.dbDirty = false;
				if (state) {
					ui.db = databaseDraft(state);
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
