/** Pure state → HTML for the Configure panel, plus the form drafts it edits. Unit-tested in Node. */

import {
	EngineChoice,
	PanelDatabaseForm,
	PanelMigrations,
	PanelNotice,
	PanelScript,
	PanelServer,
	PanelServerForm,
	PanelState,
	PanelStep,
	PanelStream,
	PanelSuggestion,
	PanelTab,
	RunsIn,
	Scope,
} from '../shared/panelProtocol';
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
	cwd: string;
	onStartup: boolean;
	onBranchChange: boolean;
	onSave: boolean;
	/** Comma-separated globs; empty = any file. */
	savePatterns: string;
	onGitUpdate: boolean;
	/** Comma-separated globs of files that must have changed; empty = always. */
	gitPatterns: string;
	steps: StepDraft[];
	/** `KEY=value` per line. */
	env: string;
	/** `name = option1, option2` per line; the first option is the default. */
	inputs: string;
}

export type ServerDraft = PanelServerForm;

export type Editing =
	| { kind: 'script'; originalId?: string; draft: ScriptDraft }
	| { kind: 'server'; originalId?: string; draft: ServerDraft };

export interface SuggestionList {
	tab: 'servers' | 'scripts';
	items: PanelSuggestion[];
	/** Ids ticked to add. */
	picked: string[];
}

export interface PanelUi {
	tab: PanelTab;
	/** Where each tab saves: this workspace or all of them. */
	scope: Record<PanelTab, Scope>;
	db: DatabaseDraft;
	/** The Database form was changed and not saved; incoming state doesn't overwrite it. */
	dbDirty: boolean;
	migrations: PanelMigrations;
	migrationsDirty: boolean;
	/** The icon picker of the script form is open, and what's typed in its search box. */
	iconPicker?: boolean;
	iconSearch: string;
	/** The Migrations card is expanded; undefined = expanded when migrations are set up. */
	migrationsOpen?: boolean;
	editing?: Editing;
	suggestions?: SuggestionList;
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

export function migrationsDraft(state: PanelState): PanelMigrations {
	return { ...state.migrations, streams: state.migrations.streams.map((stream) => ({ ...stream })) };
}

export function emptyStream(): PanelStream {
	return { name: '', versionQuery: 'SELECT version_num FROM alembic_version', versionsPath: '', downgradeCommand: 'alembic downgrade ${revision}', cwd: '' };
}

/** Initial save scope per tab: where its values live now, else this workspace. */
export function initialScope(state: PanelState): Record<PanelTab, Scope> {
	return {
		database: state.stored.database ?? 'local',
		servers: state.stored.servers ?? 'local',
		scripts: state.stored.scripts ?? 'local',
	};
}

export function emptyStep(): StepDraft {
	return { kind: 'run', label: '', run: '', from: '', to: '', ifMissing: true };
}

export function scriptDraft(script?: PanelScript): ScriptDraft {
	if (!script) {
		return { label: '', icon: 'play', cwd: '', ...triggerDraft(undefined), steps: [emptyStep()], env: '', inputs: '' };
	}
	return {
		label: script.label,
		icon: script.icon,
		cwd: script.cwd ?? '',
		...triggerDraft(script.runOn),
		steps: script.steps.map((step): StepDraft => ('run' in step
			? { ...emptyStep(), label: step.label === step.run ? '' : step.label, run: step.run }
			: { ...emptyStep(), kind: 'copy', label: step.label, from: step.copyFile.from, to: step.copyFile.to, ifMissing: step.copyFile.ifMissing })),
		env: Object.entries(script.env).map(([key, value]) => `${key}=${value}`).join('\n'),
		inputs: Object.entries(script.inputs)
			.map(([name, input]) => `${name} = ${[input.default, ...input.options.filter((option) => option !== input.default)].join(', ')}`)
			.join('\n'),
	};
}

function triggerDraft(runOn: PanelScript['runOn']): Pick<ScriptDraft, 'onStartup' | 'onBranchChange' | 'onSave' | 'savePatterns' | 'onGitUpdate' | 'gitPatterns'> {
	return {
		onStartup: runOn?.startup ?? false,
		onBranchChange: runOn?.branchChange ?? false,
		onSave: runOn?.fileSave ?? false,
		savePatterns: (runOn?.fileSavePatterns ?? []).join(', '),
		onGitUpdate: runOn?.gitUpdate ?? false,
		gitPatterns: (runOn?.gitUpdatePatterns ?? []).join(', '),
	};
}

const globs = (text: string) => text.split(',').map((item) => item.trim()).filter(Boolean);

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
		...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
		...(draft.onStartup || draft.onBranchChange || draft.onSave || draft.onGitUpdate
			? {
				runOn: {
					startup: draft.onStartup,
					branchChange: draft.onBranchChange,
					fileSave: draft.onSave,
					fileSavePatterns: globs(draft.savePatterns),
					gitUpdate: draft.onGitUpdate,
					gitUpdatePatterns: globs(draft.gitPatterns),
				},
			}
			: {}),
		env,
		inputs,
		steps: draft.steps.map((step): PanelStep => (step.kind === 'run'
			? { label: step.label, run: step.run }
			: { label: step.label, copyFile: { from: step.from, to: step.to, ifMissing: step.ifMissing } })),
	};
}

export function serverDraft(server?: PanelServer): ServerDraft {
	return server
		? { label: server.label, command: server.command, debugConfiguration: server.debugConfiguration, restartOnDatabaseChange: server.restartOnDatabaseChange, cwd: server.cwd, runOnStartup: server.runOnStartup }
		: { label: '', command: '', debugConfiguration: '', restartOnDatabaseChange: true, cwd: '', runOnStartup: false };
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

/** Most icons the grid shows at once; typing narrows it down. */
const ICON_LIMIT = 240;

/** Icons whose name has every word of `search` (`git br` → git-branch, git-branch-create…). */
export function matchingIcons(icons: readonly string[], search: string): string[] {
	const words = search.toLowerCase().split(/[\s-]+/).filter(Boolean);
	return icons.filter((name) => words.every((word) => name.includes(word)));
}

export function renderIconGrid(icons: readonly string[], search: string, selected: string): string {
	const matches = matchingIcons(icons, search);
	if (matches.length === 0) {
		return `<p class="icon-none">No icon matches "${e(search)}".</p>`;
	}
	const buttons = matches.slice(0, ICON_LIMIT).map((name) => `<button class="icon-choice${name === selected ? ' is-selected' : ''}" data-action="pick-icon" data-id="${e(name)}" title="${e(name)}" aria-label="${e(name)}">${icon(name)}</button>`).join('');
	const more = matches.length > ICON_LIMIT ? `<p class="icon-none">Showing ${ICON_LIMIT} of ${matches.length}. Keep typing to narrow it down.</p>` : '';
	return buttons + more;
}

/** The current icon as a button; open, a search box over every codicon. */
function renderIconPicker(state: PanelState, ui: PanelUi, selected: string): string {
	const name = selected || 'play';
	const popover = ui.iconPicker
		? `<div class="icon-popover">
			<input type="search" data-bind="iconSearch" value="${e(ui.iconSearch)}" spellcheck="false" placeholder="Search ${state.icons.length} icons, e.g. rocket, database, test" aria-label="Search icons" data-autofocus>
			<div class="icon-grid" role="listbox" aria-label="Icons">${renderIconGrid(state.icons, ui.iconSearch, name)}</div>
		</div>`
		: '';
	return `<div class="field"><span class="field-label">Icon</span>
		<div class="icon-picker">
			<button class="secondary icon-current" data-action="icon-toggle" aria-expanded="${ui.iconPicker ? 'true' : 'false'}">${icon(name)}<span>${e(name)}</span>${icon(ui.iconPicker ? 'chevron-up' : 'chevron-down')}</button>
			${popover}
		</div>
	</div>`;
}

const FOLDER_HINT = 'Relative to the workspace, e.g. <code>frontend</code>. Empty = the workspace folder.';

export function renderPanel(state: PanelState | undefined, ui: PanelUi): string {
	if (!state) {
		return '<div class="loading">Loading…</div>';
	}
	const tabs = TABS.map((tab) => {
		const stored = state.stored[tab.id];
		const dot = stored ? `<span class="dot dot-${stored}" title="${stored === 'global' ? 'Saved for all workspaces' : 'Saved for this workspace'}; overrides settings.json"></span>` : '';
		return `<button class="tab${tab.id === ui.tab ? ' is-active' : ''}" role="tab" aria-selected="${tab.id === ui.tab}" data-action="tab" data-id="${tab.id}">${icon(tab.icon)}${e(tab.label)}${dot}</button>`;
	}).join('');
	const body = ui.tab === 'database' ? renderDatabase(state, ui) : ui.tab === 'servers' ? renderServers(state, ui) : renderScripts(state, ui);
	return `<header class="top">
		<h1>${icon('rocket')}Automated Processes</h1>
		<nav class="tabs" role="tablist">${tabs}</nav>
	</header>
	${state.problems.length ? `<div class="banner banner-error">${icon('error')}<div><strong>Settings need attention</strong><ul>${state.problems.map((problem) => `<li>${e(problem)}</li>`).join('')}</ul></div></div>` : ''}
	<main class="content">${body}</main>`;
}

/** "Save for: This workspace | All workspaces", shown at the top of each tab. */
function renderScope(state: PanelState, ui: PanelUi, tab: PanelTab): string {
	const scope = ui.scope[tab];
	const stored = state.stored[tab];
	const button = (value: Scope, label: string, title: string) =>
		`<button class="segment${scope === value ? ' is-active' : ''}" aria-pressed="${scope === value}" data-action="scope" data-id="${value}" title="${e(title)}">${e(label)}</button>`;
	const where = stored === 'local' ? 'saved for this workspace' : stored === 'global' ? 'saved for all workspaces' : 'from settings.json';
	return `<div class="scope">
		<span class="scope-label">Save for</span>
		<div class="segments" role="group" aria-label="Save for">
			${button('local', 'This workspace', 'Only this project uses what you save here')}
			${button('global', 'All workspaces', 'Every project uses what you save here, unless it has its own')}
		</div>
		<span class="scope-now">Now: ${e(where)}${stored ? ` · <button class="link" data-action="reset" data-id="${tab}">use settings.json</button>` : ''}</span>
	</div>`;
}

function renderNotice(ui: PanelUi, tab: PanelTab, area?: 'migrations'): string {
	const notice = ui.notice;
	if (!notice || notice.tab !== tab || notice.area !== area) {
		return '';
	}
	return `<div class="notice notice-${notice.kind}" role="status">${icon(notice.kind === 'ok' ? 'pass-filled' : 'error')}<span>${e(notice.message)}</span></div>`;
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
		${renderScope(state, ui, 'database')}
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
	</section>`;
}

function renderSuggestions(ui: PanelUi, tab: 'servers' | 'scripts'): string {
	const list = ui.suggestions;
	if (!list || list.tab !== tab || list.items.length === 0) {
		return '';
	}
	const kinds: Record<PanelSuggestion['kind'], string> = { server: 'server-process', script: 'play', migrations: 'arrow-up', stream: 'history' };
	const rows = list.items.map((item) => `<li class="item suggestion${item.exists ? ' is-existing' : ''}">
		<label class="check"><input type="checkbox" data-action="pick" data-id="${e(item.id)}"${list.picked.includes(item.id) ? ' checked' : ''}>
			${icon(kinds[item.kind], 'item-icon')}
			<span class="item-text"><span class="item-title">${e(item.label)}${item.exists ? ' <span class="pill">already there</span>' : ''}</span><span class="item-detail" title="${e(item.detail)}">${e(item.detail)}</span></span>
		</label>
	</li>`).join('');
	return `<div class="editor suggestions">
		<h3>${icon('sparkle')}Found in this project</h3>
		<ul class="items">${rows}</ul>
		<div class="actions">
			<button class="primary" data-action="add-suggestions"${list.picked.length === 0 ? ' disabled' : ''}>${icon('add')}Add ${list.picked.length || ''} selected</button>
			<button class="secondary" data-action="close-suggestions">Cancel</button>
		</div>
	</div>`;
}

function renderServers(state: PanelState, ui: PanelUi): string {
	const editing = ui.editing?.kind === 'server' ? ui.editing : undefined;
	const rows = state.servers.map((server) => {
		const badge = server.source === 'launch'
			? '<span class="pill">launch.json</span>'
			: server.debugConfiguration ? '<span class="pill">debug</span>' : '';
		const detail = [
			server.command ? `run: ${server.command}` : '',
			server.debugConfiguration ? `debug: ${server.debugConfiguration}` : '',
			server.cwd ? `in ${server.cwd}` : '',
		].filter(Boolean).join(' · ');
		const id = e(server.id);
		return `<li class="item${editing?.originalId === server.id ? ' is-editing' : ''}">
			${icon('server-process', 'item-icon')}
			<div class="item-text"><span class="item-title">${e(server.label)} ${badge}${server.runOnStartup ? ' <span class="pill pill-auto">on startup</span>' : ''}</span><span class="item-detail" title="${e(detail)}">${e(detail || 'nothing to run')}${server.restartOnDatabaseChange ? '' : ' · not restarted on database change'}</span></div>
			<div class="item-actions">
				${iconButton('edit', server.source === 'launch' ? `Add a run command to ${server.label}` : `Edit ${server.label}`, `data-action="edit-server" data-id="${id}"`)}
				${server.source === 'launch'
					? iconButton('go-to-file', 'Defined in launch.json', 'data-action="open-launch"')
					: iconButton('trash', `Delete ${server.label}`, `data-action="delete-server" data-id="${id}"`)}
			</div>
		</li>`;
	}).join('');
	const launch = state.launchConfigurations.map((item) => `<li class="item">
		${icon('debug-alt', 'item-icon')}
		<div class="item-text"><span class="item-title">${e(item.name)}</span></div>
		<div class="item-actions">${item.added
			? `<span class="added">${icon('check')}Added</span>`
			: `<button class="secondary small" data-action="add-launch" data-id="${e(item.name)}">${icon('add')}Add as server</button>`}</div>
	</li>`).join('');
	return `<section class="card">
		<h2>Servers</h2>
		<p class="lead">Each server gets run, debug, restart and stop buttons in the sidebar, and runs with the current database.</p>
		${renderScope(state, ui, 'servers')}
		${renderNotice(ui, 'servers')}
		${rows ? `<ul class="items">${rows}</ul>` : '<p class="empty">No servers yet. <b>Add defaults</b> looks at package.json, your Python app and launch.json.</p>'}
		${renderSuggestions(ui, 'servers')}
		${editing ? renderServerForm(state, editing) : `<div class="actions">
			<button class="primary" data-action="add-server">${icon('add')}Add server</button>
			<button class="secondary" data-action="detect" data-id="servers">${icon('sparkle')}Add defaults</button>
		</div>`}
	</section>
	<section class="card">
		<h2>launch.json</h2>
		<p class="lead">Add a debug configuration as a server to get its debug button in the sidebar; edit the server to give it a run command too.</p>
		${launch ? `<ul class="items">${launch}</ul>` : '<p class="empty">No launch configurations in <code>.vscode/launch.json</code>.</p>'}
		<div class="actions"><button class="secondary" data-action="open-launch">${icon('go-to-file')}Open launch.json</button></div>
		<label class="check toggle"><input type="checkbox" data-action="include-launch"${state.includeLaunchConfigurations ? ' checked' : ''}><span>Show every launch.json configuration as a server, without adding them</span></label>
	</section>`;
}

function renderServerForm(state: PanelState, editing: Extract<Editing, { kind: 'server' }>): string {
	const draft = editing.draft;
	const names = [...new Set([...state.launchConfigurations.map((item) => item.name), ...(draft.debugConfiguration ? [draft.debugConfiguration] : [])])];
	const known = new Set(state.launchConfigurations.map((item) => item.name));
	const debug = `<select data-bind="editing.draft.debugConfiguration">
		${option('', 'None', draft.debugConfiguration)}
		${names.map((name) => option(name, known.has(name) ? name : `${name} (not in launch.json)`, draft.debugConfiguration)).join('')}
	</select>`;
	return `<div class="editor" data-form="server">
		<h3>${editing.originalId ? `Edit ${e(draft.label || 'server')}` : 'New server'}</h3>
		<div class="row">
			${field('Name', text('editing.draft.label', draft.label, 'placeholder="Backend" data-autofocus'))}
			${field('Run command', text('editing.draft.command', draft.command, 'placeholder="npm run dev"'), 'Runs in the background with the current database. Empty = debug only.')}
		</div>
		<div class="row">
			${field('Folder', text('editing.draft.cwd', draft.cwd, 'placeholder="(workspace folder)"'), FOLDER_HINT)}
			${field('Debug with', debug, 'A launch.json configuration for the debug button.')}
		</div>
		${check('editing.draft.restartOnDatabaseChange', draft.restartOnDatabaseChange, 'Restart when the current database changes (off for a frontend)')}
		${check('editing.draft.runOnStartup', draft.runOnStartup, 'Run when VS Code starts (with its run command, else under the debugger)')}
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
		const steps = script.steps.map((step) => step.label).join(' → ') + (script.cwd ? ` · in ${script.cwd}` : '');
		const triggers = triggerLabels(script.runOn).map((label) => ` <span class="pill pill-auto">${e(label)}</span>`).join('');
		return `<li class="item${editing?.originalId === script.id ? ' is-editing' : ''}">
			${icon(script.icon, 'item-icon')}
			<div class="item-text"><span class="item-title">${e(script.label)}${triggers}</span><span class="item-detail" title="${e(steps)}">${e(steps)}</span></div>
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
		${renderScope(state, ui, 'scripts')}
		${renderNotice(ui, 'scripts')}
		${rows ? `<ul class="items">${rows}</ul>` : '<p class="empty">No scripts yet. <b>Add defaults</b> looks at package.json and your Python project.</p>'}
		${renderSuggestions(ui, 'scripts')}
		${editing ? renderScriptForm(state, ui, editing) : `<div class="actions">
			<button class="primary" data-action="add-script">${icon('add')}Add script</button>
			<button class="secondary" data-action="detect" data-id="scripts">${icon('sparkle')}Add defaults</button>
		</div>`}
	</section>
	${renderMigrations(state, ui)}`;
}

/** Short names of a script's triggers, for badges. */
export function triggerLabels(runOn: PanelScript['runOn']): string[] {
	return [
		runOn?.startup ? 'on startup' : '',
		runOn?.branchChange ? 'on branch change' : '',
		runOn?.gitUpdate ? 'on new commits' : '',
		runOn?.fileSave ? 'on save' : '',
	].filter(Boolean);
}

/** Migrations are set up when there's a command or a Sync Migrations history. */
export function hasMigrations(migrations: PanelMigrations): boolean {
	return migrations.command.trim() !== '' || migrations.streams.length > 0;
}

function renderMigrations(state: PanelState, ui: PanelUi): string {
	const draft = ui.migrations;
	const configured = hasMigrations(state.migrations);
	const open = ui.migrationsOpen ?? configured;
	if (!open) {
		// Folded away: one line with what's set and how to get it back.
		const count = state.migrations.streams.length;
		const summary = configured
			? `Run Migrations: <code>${e(state.migrations.command || '(none)')}</code>${count ? ` · ${count} Sync Migrations histor${count === 1 ? 'y' : 'ies'}` : ''}`
			: 'Not set up. Add a command to get Run Migrations (and Sync Migrations) in the sidebar.';
		return `<section class="card card-folded">
			<div class="folded">
				${icon('arrow-up', 'item-icon')}
				<div class="item-text"><span class="item-title">Migrations</span><span class="item-detail">${summary}</span></div>
				<button class="secondary small" data-action="migrations-open">${icon(configured ? 'chevron-down' : 'add')}${configured ? 'Show' : 'Add migrations'}</button>
			</div>
			${renderNotice(ui, 'scripts', 'migrations')}
		</section>`;
	}
	const streams = draft.streams.map((stream, index) => {
		const at = `migrations.streams.${index}`;
		return `<li class="step">
			<div class="step-head step-head-stream">
				<span class="step-number">${index + 1}</span>
				${text(`${at}.name`, stream.name, 'placeholder="Name, e.g. tenant" aria-label="Name"')}
				<div class="item-actions">${iconButton('close', 'Remove this history', `data-action="remove-stream" data-index="${index}"`)}</div>
			</div>
			<div class="row">
				${field('Versions folder', text(`${at}.versionsPath`, stream.versionsPath, 'placeholder="alembic/versions"'), 'Where the migration files are, relative to the workspace.')}
				${field('Version query', text(`${at}.versionQuery`, stream.versionQuery), 'SQL returning the applied revisions.')}
			</div>
			<div class="row">
				${field('Downgrade command', text(`${at}.downgradeCommand`, stream.downgradeCommand), 'Must contain <code>${revision}</code>.')}
				${field('Folder', text(`${at}.cwd`, stream.cwd, 'placeholder="(checkout root)"'), 'Where it runs, inside the other branch\'s checkout.')}
			</div>
		</li>`;
	}).join('');
	return `<section class="card">
		<div class="card-head">
			<h2>Migrations</h2>
			<div class="item-actions">
				${configured ? `<button class="secondary small" data-action="remove-migrations" title="Clear the command and histories">${icon('trash')}Remove</button>` : ''}
				<button class="secondary small" data-action="migrations-close" title="Fold this section away">${icon('chevron-up')}Hide</button>
			</div>
		</div>
		<p class="lead"><b>Run Migrations</b> and <b>Sync Migrations</b> show up with the scripts once they're set.</p>
		${renderNotice(ui, 'scripts', 'migrations')}
		<div class="row">
			${field('Run Migrations command', text('migrations.command', draft.command, 'placeholder="npx prisma migrate deploy"'), 'Applies migrations to the current database. Empty = no Run Migrations button.')}
			${field('Folder', text('migrations.cwd', draft.cwd, 'placeholder="(workspace folder)"'), FOLDER_HINT)}
		</div>
		<div class="row">
			${field('Run on branch change', `<select data-bind="migrations.onBranchChange">${option('off', 'Never', draft.onBranchChange)}${option('ask', 'Ask', draft.onBranchChange)}${option('always', 'Always', draft.onBranchChange)}</select>`)}
			<div class="field field-check">${check('migrations.afterCopy', draft.afterCopy, 'Run them after Export Data copies a database')}</div>
		</div>
		<div class="field"><span class="field-label">Sync Migrations histories</span>
			<span class="field-hint">Sync Migrations undoes migrations other branches applied to the current database, using their code. One entry per migration history (Alembic: one per <code>alembic.ini</code>), in the order to undo them.</span>
			${streams ? `<ol class="steps">${streams}</ol>` : ''}
			<div><button class="secondary" data-action="add-stream">${icon('add')}Add history</button></div>
		</div>
		<div class="actions">
			<button class="primary" data-action="save-migrations">${icon('save')}Save migrations</button>
			${ui.migrationsDirty ? '<button class="secondary" data-action="discard-migrations">Discard changes</button>' : ''}
		</div>
	</section>`;
}

function renderScriptForm(state: PanelState, ui: PanelUi, editing: Extract<Editing, { kind: 'script' }>): string {
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
			${renderIconPicker(state, ui, draft.icon)}
			${field('Folder', text('editing.draft.cwd', draft.cwd, 'placeholder="(workspace folder)"'), FOLDER_HINT)}
		</div>
		<div class="field"><span class="field-label">Run automatically</span>
			<div class="triggers">
				${check('editing.draft.onStartup', draft.onStartup, 'When VS Code starts')}
				${check('editing.draft.onBranchChange', draft.onBranchChange, 'When the branch changes')}
				${check('editing.draft.onGitUpdate', draft.onGitUpdate, 'When the branch gets new commits (pull, merge, rebase)')}
				${draft.onGitUpdate ? text('editing.draft.gitPatterns', draft.gitPatterns, 'placeholder="Only if these changed, e.g. package-lock.json, uv.lock (empty = always)" aria-label="Only if these files changed"') : ''}
				${check('editing.draft.onSave', draft.onSave, 'When a file is saved')}
				${draft.onSave ? text('editing.draft.savePatterns', draft.savePatterns, 'placeholder="Only these files, e.g. *.py, src/* (empty = any file)" aria-label="Only for these files"') : ''}
			</div>
			<span class="field-hint">Off by default. An automatic run is skipped while another script runs.</span>
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
