import '@vscode-elements/elements/dist/vscode-button/index.js';
import '@vscode-elements/elements/dist/vscode-checkbox/index.js';
import '@vscode-elements/elements/dist/vscode-option/index.js';
import '@vscode-elements/elements/dist/vscode-single-select/index.js';
import type { BranchChangeMode, CommandName, ExtensionMessage, ViewState, WebviewMessage } from '../shared/protocol';
import { renderApp } from './render';

interface VsCodeApi {
	postMessage(message: WebviewMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();
const root = document.getElementById('app') as HTMLElement;
let state: ViewState | undefined;
let receivedAt = 0;

function post(message: WebviewMessage): void {
	api.postMessage(message);
}

function render(): void {
	if (!state) {
		return;
	}
	const now = state.now + (Date.now() - receivedAt);
	root.innerHTML = renderApp(state, now);
	bindInputs();
}

function bindInputs(): void {
	root.querySelectorAll<HTMLElement & { value: string }>('vscode-single-select[data-input]').forEach((select) => {
		select.addEventListener('change', () => {
			post({ type: 'setInput', scriptId: select.dataset.script ?? '', name: select.dataset.input ?? '', value: select.value });
		});
	});
	root.querySelectorAll<HTMLElement & { value: string }>('vscode-single-select[data-branch-mode]').forEach((select) => {
		select.addEventListener('change', () => post({ type: 'setOnBranchChange', value: select.value as BranchChangeMode }));
	});
	root.querySelectorAll<HTMLElement & { checked: boolean }>('vscode-checkbox[data-toggle="showHidden"]').forEach((checkbox) => {
		checkbox.addEventListener('change', () => post({ type: 'setShowHidden', value: checkbox.checked }));
	});
	root.querySelectorAll<HTMLElement & { value: string }>('vscode-single-select[data-server-restart]').forEach((select) => {
		select.addEventListener('change', () => post({ type: 'setServerRestartMode', value: select.value as 'restart' | 'ask' | 'off' }));
	});
	root.querySelectorAll<HTMLElement & { value: string }>('vscode-single-select[data-import-data]').forEach((select) => {
		select.addEventListener('change', () => post({ type: 'setImportDataOnCreate', value: select.value === 'on' }));
	});
}

root.addEventListener('click', (event) => {
	const target = (event.target as HTMLElement).closest<HTMLElement>(
		'[data-command], [data-run-script], [data-migrate-from], [data-migrate-to]',
	);
	if (!target || target.hasAttribute('disabled')) {
		return;
	}
	const data = target.dataset;
	if (data.runScript) {
		post({ type: 'runScript', scriptId: data.runScript, step: data.step === undefined ? undefined : Number(data.step) });
	} else if (data.migrateFrom) {
		post({ type: 'migrateFrom', database: data.migrateFrom });
	} else if (data.migrateTo) {
		post({ type: 'migrateTo', database: data.migrateTo });
	} else if (data.command) {
		post({ type: 'command', command: data.command as CommandName, database: data.database });
	}
});

window.addEventListener('message', (event: MessageEvent<ExtensionMessage>) => {
	if (event.data?.type === 'state') {
		state = event.data.state;
		receivedAt = Date.now();
		render();
	}
});

// Keep durations and relative times fresh: every second while a script runs, otherwise every 30 s.
let lastTick = 0;
setInterval(() => {
	const running = state?.run?.status === 'running';
	if (running || Date.now() - lastTick > 30_000) {
		lastTick = Date.now();
		render();
	}
}, 1000);

post({ type: 'ready' });
