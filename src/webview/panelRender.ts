/** Pure state → HTML for the Configure panel, plus the form drafts it edits. Unit-tested in Node. */

import { EngineChoice, PanelDatabaseForm, PanelNotice, PanelScript, PanelServer, PanelState, PanelStep, PanelTab, RunsIn } from '../shared/panelProtocol';
import { escapeHtml as e } from './render';

// ── Drafts (what the forms edit) ─────────────────────────────────────────────

export interface DatabaseDraft {
	engine: EngineChoice;
	source: 'envFile' | 'url';
	envFile: string;
	urlVariable: string;
	/** A newly typed URL; empty = keep the saved one. */
	url: string;
	runsIn: RunsIn;
	dockerName: string;
	sqliteFolder: string;
	mainBranches: string;
}

export interface StepDraft {
	kind: 'run' | 'copy';
	label: string;
	run: string;
	from: string;
	to: string;
	ifMissing: boolean;
}

export interface ScriptDraft {
	label: string;
	icon: string;
	steps: StepDraft[];
	/** `KEY=value` per line. */
	env: string;
	/** `name = option1, option2` per line; the first option is the default. */
	inputs: string;
}

export interface ServerDraft {
	label: string;
	command: string;
	debugConfiguration: string;
	restartOnDatabaseChange: boolean;
}

export type Editing =
	| { kind: 'script'; originalId?: string; draft: ScriptDraft }
	| { kind: 'server'; originalId?: string; draft: ServerDraft };

export interface PanelUi {
	tab: PanelTab;
	db: DatabaseDraft;
	/** The Database form was changed and not saved; incoming state doesn't overwrite it. */
	dbDirty: boolean;
	editing?: Editing;
	notice?: PanelNotice;
}

export function databaseDraft(state: PanelState): DatabaseDraft {
	const db = state.database;
	return {
		engine: db.engine,
		source: db.source,
		envFile: db.envFile,
		urlVariable: db.urlVariable,
		url: '',
		runsIn: db.runsIn,
		dockerName: db.dockerName,
		sqliteFolder: db.sqliteFolder,
		mainBranches: db.mainBranches.join(', '),
	};
}

export function databaseForm(draft: DatabaseDraft): PanelDatabaseForm {
	return {
		engine: draft.engine,
		source: draft.source,
		envFile: draft.envFile,
		urlVariable: draft.urlVariable,
		url: draft.source === 'url' && draft.url.trim() ? draft.url.trim() : undefined,
		runsIn: draft.runsIn,
		dockerName: draft.dockerName,
		sqliteFolder: draft.sqliteFolder,
		mainBranches: draft.mainBranches.split(',').map((branch) => branch.trim()).filter(Boolean),
	};
}

export function emptyStep(): StepDraft {
	return { kind: 'run', label: '', run: '', from: '', to: '', ifMissing: true };
}

export function scriptDraft(script?: PanelScript): ScriptDraft {
	if (!script) {
		return { label: '', icon: 'play', steps: [emptyStep()], env: '', inputs: '' };
	}
	return {
		label: script.label,
		icon: script.icon,
		steps: script.steps.map((step): StepDraft => ('run' in step
			? { ...emptyStep(), label: step.label === step.run ? '' : step.label, run: step.run }
			: { ...emptyStep(), kind: 'copy', label: step.label, from: step.copyFile.from, to: step.copyFile.to, ifMissing: step.copyFile.ifMissing })),
		env: Object.entries(script.env).map(([key, value]) => `${key}=${value}`).join('\n'),
		inputs: Object.entries(script.inputs)
			.map(([name, input]) => `${name} = ${[input.default, ...input.options.filter((option) => option !== input.default)].join(', ')}`)
			.join('\n'),
	};
}

export function draftToScript(draft: ScriptDraft, id = ''): PanelScript {
	const env: Record<string, string> = {};
	for (const line of draft.env.split(/\r?\n/)) {
		const equals = line.indexOf('=');
		if (equals > 0) {
			env[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
		}
	}
	const inputs: PanelScript['inputs'] = {};
	for (const line of draft.inputs.split(/\r?\n/)) {
		const equals = line.indexOf('=');
		if (equals > 0) {
			const options = line.slice(equals + 1).split(',').map((option) => option.trim()).filter(Boolean);
			if (options.length > 0) {
				inputs[line.slice(0, equals).trim()] = { options, default: options[0] };
			}
		}
	}
	return {
		id,
		label: draft.label,
		icon: draft.icon,
		env,
		inputs,
		steps: draft.steps.map((step): PanelStep => (step.kind === 'run'
			? { label: step.label, run: step.run }
			: { label: step.label, copyFile: { from: step.from, to: step.to, ifMissing: step.ifMissing } })),
	};
}

export function serverDraft(server?: PanelServer): ServerDraft {
	return server
		? { label: server.label, command: server.command, debugConfiguration: server.debugConfiguration, restartOnDatabaseChange: server.restartOnDatabaseChange }
		: { label: '', command: '', debugConfiguration: '', restartOnDatabaseChange: true };
}

// ── Rendering ────────────────────────────────────────────────────────────────

const TABS: { id: PanelTab; label: string; icon: string }[] = [
	{ id: 'database', label: 'Database', icon: 'database' },
	{ id: 'servers', label: 'Servers', icon: 'server-process' },
	{ id: 'scripts', label: 'Scripts', icon: 'play' },
];

function icon(name: string, extra = ''): string {
	return `<span class="codicon codicon-${e(name)}${extra ? ` ${extra}` : ''}" aria-hidden="true"></span>`;
}

function iconButton(iconName: string, title: string, attrs: string): string {
	return `<button class="icon-button" title="${e(title)}" aria-label="${e(title)}" ${attrs}>${icon(iconName)}</button>`;
}

function option(value: string, label: string, selected: string): string {
	return `<option value="${e(value)}"${value === selected ? ' selected' : ''}>${e(label)}</option>`;
}

function field(label: string, control: string, hint = ''): string {
	return `<label class="field"><span class="field-label">${e(label)}</span>${control}${hint ? `<span class="field-hint">${hint}</span>` : ''}</label>`;
}

function text(bind: string, value: string, attrs = ''): string {
	return `<input type="text" data-bind="${e(bind)}" value="${e(value)}" spellcheck="false" ${attrs}>`;
}

function check(bind: string, checked: boolean, label: string): string {
	return `<label class="check"><input type="checkbox" data-bind="${e(bind)}"${checked ? ' checked' : ''}><span>${e(label)}</span></label>`;
}

export function renderPanel(state: PanelState | undefined, ui: PanelUi): string {
	if (!state) {
		return '<div class="loading">Loading…</div>';
	}
	const tabs = TABS.map((tab) => `<button class="tab${tab.id === ui.tab ? ' is-active' : ''}" role="tab" aria-selected="${tab.id === ui.tab}" data-action="tab" data-id="${tab.id}">${icon(tab.icon)}${e(tab.label)}${state.stored[tab.id] ? '<span class="dot" title="Saved in the extension, overrides settings.json"></span>' : ''}</button>`).join('');
	const body = ui.tab === 'database' ? renderDatabase(state, ui) : ui.tab === 'servers' ? renderServers(state, ui) : renderScripts(state, ui);
	return `<header class="top">
		<h1>${icon('rocket')}Automated Processes</h1>
		<nav class="tabs" role="tablist">${tabs}</nav>
	</header>
	${state.problems.length ? `<div class="banner banner-error">${icon('error')}<div><strong>Settings need attention</strong><ul>${state.problems.map((problem) => `<li>${e(problem)}</li>`).join('')}</ul></div></div>` : ''}
	<main class="content">${body}</main>`;
}

function renderNotice(ui: PanelUi, tab: PanelTab): string {
	const notice = ui.notice;
	if (!notice || notice.tab !== tab) {
		return '';
	}
	return `<div class="notice notice-${notice.kind}" role="status">${icon(notice.kind === 'ok' ? 'pass-filled' : 'error')}<span>${e(notice.message)}</span></div>`;
}

function storedNote(state: PanelState, tab: PanelTab, what: string): string {
	return state.stored[tab]
		? `<p class="note">${icon('info')}${e(what)} saved here, on this machine; they override <code>settings.json</code>. <button class="link" data-action="reset" data-id="${tab}">Use settings.json instead</button></p>`
		: `<p class="note">${icon('info')}Showing the values from <code>settings.json</code>. Saving here stores them in the extension, on this machine, without touching the repository.</p>`;
}

/** SQLite, PostgreSQL or unknown, for showing the fields that apply. */
export function effectiveEngine(state: PanelState, draft: DatabaseDraft): 'postgres' | 'sqlite' | undefined {
	if (draft.engine !== 'auto') {
		return draft.engine;
	}
	if (draft.source === 'url' && draft.url.trim()) {
		return /^(sqlite[^:]*:|file:)|\.(db|db3|sqlite|sqlite3)$/i.test(draft.url.trim()) ? 'sqlite' : 'postgres';
	}
	return state.database.detectedEngine;
}

function renderDatabase(state: PanelState, ui: PanelUi): string {
	const draft = ui.db;
	const engine = effectiveEngine(state, draft);
	const detected = state.database.detectedEngine;
	const engineLabel = (kind: 'postgres' | 'sqlite' | undefined) => (kind === 'sqlite' ? 'SQLite' : kind === 'postgres' ? 'PostgreSQL' : 'unknown');
	const engineSelect = `<select data-bind="db.engine">
		${option('auto', `Detect from the URL${detected ? ` (${engineLabel(detected)})` : ''}`, draft.engine)}
		${option('postgres', 'PostgreSQL', draft.engine)}
		${option('sqlite', 'SQLite', draft.engine)}
	</select>`;
	const source = `<div class="radios" role="radiogroup">
		<label class="check"><input type="radio" name="source" data-bind="db.source" value="envFile"${draft.source === 'envFile' ? ' checked' : ''}><span>From the env file</span></label>
		<label class="check"><input type="radio" name="source" data-bind="db.source" value="url"${draft.source === 'url' ? ' checked' : ''}><span>Enter it here</span></label>
	</div>`;
	const sourceFields = draft.source === 'envFile'
		? `<div class="row">${field('Env file', text('db.envFile', draft.envFile, 'placeholder=".env"'), 'Relative to the workspace folder. Only read, never changed.')}
			${field('Variable', text('db.urlVariable', draft.urlVariable, 'placeholder="DATABASE_URL"'), 'Also the variable scripts, terminals and debug sessions get, pointed at the current database.')}</div>`
		: `${field('Connection URL', `<input type="password" data-bind="db.url" value="${e(draft.url)}" spellcheck="false" autocomplete="off" placeholder="${e(state.database.urlPreview ? 'Leave empty to keep the saved URL' : engine === 'sqlite' ? 'sqlite:///data/app.db' : 'postgresql://user:password@localhost:5432/app')}">`,
			`${state.database.urlPreview ? `Saved: <code>${e(state.database.urlPreview)}</code>. ` : ''}Kept in VS Code's secret storage, never in settings or the repository. ${engine === 'sqlite' ? 'Relative paths start at the folder below.' : 'The database in the URL is the main database.'}`)}
			${field('Variable', text('db.urlVariable', draft.urlVariable, 'placeholder="DATABASE_URL"'), 'Scripts, terminals and debug sessions get the URL of the current database in this variable.')}`;
	const postgres = engine !== 'sqlite'
		? `<div class="row">${field('PostgreSQL tools (psql, pg_dump) run', `<select data-bind="db.runsIn">
				${option('local', 'On this machine (from PATH)', draft.runsIn)}
				${option('container', 'In a Docker container', draft.runsIn)}
				${option('compose', 'In a Docker Compose service', draft.runsIn)}
			</select>`, draft.runsIn === 'local' ? 'Needs PostgreSQL\'s client tools installed.' : 'Nothing to install; the tools run inside the container.')}
			${draft.runsIn === 'local' ? '' : field(draft.runsIn === 'container' ? 'Container' : 'Compose service', text('db.dockerName', draft.dockerName, `placeholder="${draft.runsIn === 'container' ? 'my-db-1' : 'db'}"`), draft.runsIn === 'container' ? 'As in <code>docker exec -it my-db-1 psql</code>.' : 'The service name in the Compose file.')}</div>`
		: '';
	const sqlite = engine !== 'postgres'
		? field('Folder for relative SQLite paths', text('db.sqliteFolder', draft.sqliteFolder, 'placeholder="(workspace folder)"'), 'Relative to the workspace. Branch databases are files next to the main one, with the same extension.')
		: '';
	return `<section class="card">
		<h2>Connection</h2>
		${renderNotice(ui, 'database')}
		${field('Engine', engineSelect)}
		${field('Connection URL', source)}
		${sourceFields}
		${postgres}
		${sqlite}
		${field('Main branches', text('db.mainBranches', draft.mainBranches, 'placeholder="main"'), 'Comma-separated. They use the main database; other branches can get their own.')}
		<div class="actions">
			<button class="primary" data-action="save-db">${icon('save')}Save</button>
			<button class="secondary" data-action="test-db">${icon('plug')}Test connection</button>
			${ui.dbDirty ? `<button class="secondary" data-action="discard-db">Discard changes</button>` : ''}
		</div>
		${storedNote(state, 'database', 'Connection settings are')}
	</section>`;
}

function renderServers(state: PanelState, ui: PanelUi): string {
	const editing = ui.editing?.kind === 'server' ? ui.editing : undefined;
	const rows = state.servers.map((server) => {
		const badge = server.source === 'launch'
			? '<span class="pill">launch.json</span>'
			: server.source === 'both' ? '<span class="pill">launch.json + command</span>' : '';
		const detail = [server.command ? `run: ${server.command}` : '', server.debugConfiguration ? `debug: ${server.debugConfiguration}` : ''].filter(Boolean).join(' · ');
		const id = e(server.id);
		return `<li class="item${editing?.originalId === server.id ? ' is-editing' : ''}">
			${icon('server-process', 'item-icon')}
			<div class="item-text"><span class="item-title">${e(server.label)} ${badge}</span><span class="item-detail" title="${e(detail)}">${e(detail || 'nothing to run')}${server.restartOnDatabaseChange ? '' : ' · not restarted on database change'}</span></div>
			<div class="item-actions">
				${iconButton('edit', server.source === 'launch' ? `Add a run command to ${server.label}` : `Edit ${server.label}`, `data-action="edit-server" data-id="${id}"`)}
				${server.source === 'launch'
					? iconButton('go-to-file', 'Defined in launch.json', 'data-action="open-launch"')
					: iconButton('trash', `Delete ${server.label}`, `data-action="delete-server" data-id="${id}"`)}
			</div>
		</li>`;
	}).join('');
	return `<section class="card">
		<h2>Servers</h2>
		<p class="lead">Each server gets run, debug, restart and stop buttons in the sidebar, and restarts on the current database. launch.json configurations are listed first; give one a run command to run it without the debugger too.</p>
		${renderNotice(ui, 'servers')}
		${rows ? `<ul class="items">${rows}</ul>` : '<p class="empty">No servers yet.</p>'}
		${editing ? renderServerForm(state, editing) : `<div class="actions">
			<button class="primary" data-action="add-server">${icon('add')}Add server</button>
			<button class="secondary" data-action="open-launch">${icon('go-to-file')}Open launch.json</button>
		</div>`}
		<label class="check toggle"><input type="checkbox" data-action="include-launch"${state.includeLaunchConfigurations ? ' checked' : ''}><span>Show launch.json configurations as servers</span></label>
		${storedNote(state, 'servers', 'Servers are')}
	</section>`;
}

function renderServerForm(state: PanelState, editing: Extract<Editing, { kind: 'server' }>): string {
	const draft = editing.draft;
	const names = [...new Set([...state.launchConfigurations, ...(draft.debugConfiguration ? [draft.debugConfiguration] : [])])];
	const debug = `<select data-bind="editing.draft.debugConfiguration">
		${option('', 'None', draft.debugConfiguration)}
		${names.map((name) => option(name, state.launchConfigurations.includes(name) ? name : `${name} (not in launch.json)`, draft.debugConfiguration)).join('')}
	</select>`;
	return `<div class="editor" data-form="server">
		<h3>${editing.originalId ? `Edit ${e(draft.label || 'server')}` : 'New server'}</h3>
		<div class="row">
			${field('Name', text('editing.draft.label', draft.label, 'placeholder="Backend" data-autofocus'))}
			${field('Run command', text('editing.draft.command', draft.command, 'placeholder="npm run dev"'), 'Runs in its own terminal with the current database. Empty = debug only.')}
		</div>
		${field('Debug with', debug, 'A launch.json configuration for the debug button.')}
		${check('editing.draft.restartOnDatabaseChange', draft.restartOnDatabaseChange, 'Restart when the current database changes (off for e.g. a frontend)')}
		<div class="actions">
			<button class="primary" data-action="save-server">${icon('save')}Save</button>
			<button class="secondary" data-action="cancel">Cancel</button>
		</div>
	</div>`;
}

function renderScripts(state: PanelState, ui: PanelUi): string {
	const editing = ui.editing?.kind === 'script' ? ui.editing : undefined;
	const rows = state.scripts.map((script, index) => {
		const id = e(script.id);
		const steps = script.steps.map((step) => step.label).join(' → ');
		return `<li class="item${editing?.originalId === script.id ? ' is-editing' : ''}">
			${icon(script.icon, 'item-icon')}
			<div class="item-text"><span class="item-title">${e(script.label)}</span><span class="item-detail" title="${e(steps)}">${e(steps)}</span></div>
			<div class="item-actions">
				${iconButton('arrow-up', 'Move up', `data-action="move-script" data-id="${id}" data-delta="-1"${index === 0 ? ' disabled' : ''}`)}
				${iconButton('arrow-down', 'Move down', `data-action="move-script" data-id="${id}" data-delta="1"${index === state.scripts.length - 1 ? ' disabled' : ''}`)}
				${iconButton('edit', `Edit ${script.label}`, `data-action="edit-script" data-id="${id}"`)}
				${iconButton('trash', `Delete ${script.label}`, `data-action="delete-script" data-id="${id}"`)}
			</div>
		</li>`;
	}).join('');
	return `<section class="card">
		<h2>Scripts</h2>
		<p class="lead">Buttons in the sidebar. Steps run one after another, with the current database, and stop at the first failure.</p>
		${renderNotice(ui, 'scripts')}
		${rows ? `<ul class="items">${rows}</ul>` : '<p class="empty">No scripts yet.</p>'}
		${editing ? renderScriptForm(editing) : `<div class="actions"><button class="primary" data-action="add-script">${icon('add')}Add script</button></div>`}
		${storedNote(state, 'scripts', 'Scripts are')}
	</section>`;
}

function renderScriptForm(editing: Extract<Editing, { kind: 'script' }>): string {
	const draft = editing.draft;
	const steps = draft.steps.map((step, index) => {
		const at = `editing.draft.steps.${index}`;
		const body = step.kind === 'run'
			? field('Command', text(`${at}.run`, step.run, 'placeholder="npm ci"'), 'Placeholders: <code>${db.url}</code>, <code>${db.name}</code>, <code>${branch}</code>, <code>${env:NAME}</code>, <code>${input:NAME}</code>.')
			: `<div class="row">${field('Copy from', text(`${at}.from`, step.from, 'placeholder=".env.example"'))}${field('To', text(`${at}.to`, step.to, 'placeholder=".env"'))}</div>
				${check(`${at}.ifMissing`, step.ifMissing, 'Only when the target doesn\'t exist yet')}`;
		return `<li class="step">
			<div class="step-head">
				<span class="step-number">${index + 1}</span>
				<select data-bind="${at}.kind" aria-label="Step type">${option('run', 'Run a command', step.kind)}${option('copy', 'Copy a file', step.kind)}</select>
				${text(`${at}.label`, step.label, 'placeholder="Step name (optional)" aria-label="Step name"')}
				<div class="item-actions">
					${iconButton('arrow-up', 'Move step up', `data-action="move-step" data-index="${index}" data-delta="-1"${index === 0 ? ' disabled' : ''}`)}
					${iconButton('arrow-down', 'Move step down', `data-action="move-step" data-index="${index}" data-delta="1"${index === draft.steps.length - 1 ? ' disabled' : ''}`)}
					${iconButton('close', 'Remove step', `data-action="remove-step" data-index="${index}"${draft.steps.length === 1 ? ' disabled' : ''}`)}
				</div>
			</div>
			${body}
		</li>`;
	}).join('');
	return `<div class="editor" data-form="script">
		<h3>${editing.originalId ? `Edit ${e(draft.label || 'script')}` : 'New script'}</h3>
		<div class="row">
			${field('Name', text('editing.draft.label', draft.label, 'placeholder="Setup" data-autofocus'))}
			${field('Icon', `<div class="icon-field">${icon(draft.icon || 'play')}${text('editing.draft.icon', draft.icon, 'placeholder="play"')}</div>`, 'A <a href="https://microsoft.github.io/vscode-codicons/dist/codicon.html">codicon</a> name, e.g. tools, beaker, sparkle.')}
		</div>
		<div class="field"><span class="field-label">Steps</span><ol class="steps">${steps}</ol>
			<div><button class="secondary" data-action="add-step">${icon('add')}Add step</button></div></div>
		<div class="row">
			${field('Environment variables', `<textarea data-bind="editing.draft.env" rows="3" spellcheck="false" placeholder="SMOKE_URL=\${db.url}">${e(draft.env)}</textarea>`, 'One <code>NAME=value</code> per line. Put secrets like <code>${db.url}</code> here rather than in commands.')}
			${field('Dropdowns', `<textarea data-bind="editing.draft.inputs" rows="3" spellcheck="false" placeholder="suite = backend, frontend, all">${e(draft.inputs)}</textarea>`, 'One <code>name = option, option</code> per line, shown next to the button; the first option is the default. Use as <code>${input:name}</code>.')}
		</div>
		<div class="actions">
			<button class="primary" data-action="save-script">${icon('save')}Save</button>
			<button class="secondary" data-action="cancel">Cancel</button>
		</div>
	</div>`;
}
