/**
 * The Configure panel's logic, without VS Code: what it shows, and how its forms turn into stored
 * values. Stored values are setting keys (`scripts`, `database.engine`, …) kept in the extension's
 * storage, for this workspace or for all of them; they override the same keys in settings.json.
 */

import { Config, DatabaseEngineKind, ScriptDefinition, ServerDefinition } from './config';
import { isSqliteUrl, parseDbUrl, parseSqliteUrl } from './dbUrl';
import { Suggestion } from './detect';
import { PanelDatabase, PanelDatabaseForm, PanelMigrations, PanelServer, PanelServerForm, PanelState, PanelSuggestion, RunsIn, Scope } from '../shared/panelProtocol';

/** Keys the Database tab stores. */
export const DATABASE_KEYS = [
	'database.engine',
	'envFile',
	'database.urlVariables',
	'database.dockerContainer',
	'database.dockerComposeService',
	'database.sqliteFolder',
	'database.mainBranches',
] as const;

/** Keys the Servers tab stores (the legacy single-server keys are cleared so they can't come back). */
export const SERVER_KEYS = ['servers', 'server.command', 'server.debugConfiguration', 'server.includeLaunchConfigurations'] as const;

/** The Scripts tab also holds the migrations (Run Migrations and Sync Migrations). */
export const SCRIPT_KEYS = ['scripts', 'migrations.command', 'migrations.cwd', 'migrations.onBranchChange', 'migrations.afterCopy', 'migrations.streams'] as const;

export interface PanelInputs {
	/** Effective config, servers not merged with launch.json. */
	config: Config;
	/** Servers as the sidebar shows them (merged with launch.json when that's on). */
	servers: ServerDefinition[];
	launchConfigurations: string[];
	/** Values stored in the extension per layer (not the URL, which is a secret). */
	stored: Record<Scope, Record<string, unknown>>;
	/** The main URL in use, if it could be read (env file or stored), to detect the engine and preview. */
	mainUrl: string | undefined;
	/** Layer an entered URL comes from; undefined when it's read from the env file. */
	urlScope: Scope | undefined;
	problems: string[];
	/** Codicon names for the icon picker. */
	icons?: string[];
}

export function panelState(inputs: PanelInputs): PanelState {
	const { config } = inputs;
	const storedIn = (keys: readonly string[]): Scope | undefined => (['local', 'global'] as const)
		.find((scope) => keys.some((key) => key in inputs.stored[scope]));
	return {
		database: panelDatabase(inputs),
		servers: inputs.servers.map((server): PanelServer => ({
			id: server.id,
			label: server.label,
			command: server.command,
			debugConfiguration: server.debugConfiguration,
			restartOnDatabaseChange: server.restartOnDatabaseChange,
			cwd: server.cwd ?? '',
			runOnStartup: server.runOnStartup ?? false,
			source: server.source ?? 'config',
		})),
		launchConfigurations: inputs.launchConfigurations.map((name) => ({
			name,
			added: inputs.servers.some((server) => server.debugConfiguration === name && server.source !== 'launch'),
		})),
		includeLaunchConfigurations: config.server.includeLaunchConfigurations,
		scripts: config.scripts,
		migrations: {
			command: config.migrations.command,
			cwd: config.migrations.cwd,
			onBranchChange: config.migrations.onBranchChange,
			afterCopy: config.migrations.afterCopy,
			streams: config.migrations.streams.map(({ name, versionQuery, versionsPath, downgradeCommand, cwd }) => ({ name, versionQuery, versionsPath, downgradeCommand, cwd })),
		},
		stored: {
			database: inputs.urlScope === 'local' ? 'local' : storedIn(DATABASE_KEYS) ?? inputs.urlScope,
			servers: storedIn(SERVER_KEYS),
			scripts: storedIn(SCRIPT_KEYS),
		},
		problems: inputs.problems,
		icons: inputs.icons ?? [],
	};
}

function panelDatabase(inputs: PanelInputs): PanelDatabase {
	const { database } = inputs.config;
	const runsIn: RunsIn = database.dockerContainer ? 'container' : database.dockerComposeService ? 'compose' : 'local';
	return {
		engine: database.engine,
		detectedEngine: inputs.mainUrl ? (isSqliteUrl(inputs.mainUrl) ? 'sqlite' : 'postgres') : undefined,
		source: inputs.urlScope ? 'url' : 'envFile',
		envFile: inputs.config.envFile,
		urlVariable: database.urlVariables[0] ?? 'DATABASE_URL',
		urlPreview: inputs.urlScope && inputs.mainUrl ? maskUrl(inputs.mainUrl) : undefined,
		runsIn,
		dockerName: database.dockerContainer || database.dockerComposeService,
		sqliteFolder: database.sqliteFolder,
		mainBranches: database.mainBranches,
	};
}

/** The URL with its password replaced, safe to show. */
export function maskUrl(url: string): string {
	if (parseSqliteUrl(url)) {
		return url;
	}
	try {
		const { password } = parseDbUrl(url);
		return password ? url.replace(/(:\/\/[^:/?#@]*:)[^@]*@/, '$1•••@') : url;
	} catch {
		return '•••';
	}
}

/** Turns the Database form into stored values. Returns readable problems instead when it's invalid. */
export function databaseValues(form: PanelDatabaseForm, current: Config): { values: Record<string, unknown> } | { problem: string } {
	const engines: DatabaseEngineKind[] = ['auto', 'postgres', 'sqlite'];
	if (!engines.includes(form.engine)) {
		return { problem: 'Pick an engine.' };
	}
	const urlVariable = form.urlVariable.trim();
	if (form.source === 'envFile' && (!form.envFile.trim() || !urlVariable)) {
		return { problem: 'Enter the env file and the variable that holds the database URL.' };
	}
	if (form.source === 'envFile' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(urlVariable)) {
		return { problem: `"${urlVariable}" isn't a valid variable name.` };
	}
	const dockerName = form.dockerName.trim();
	if (form.runsIn !== 'local' && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(dockerName)) {
		return { problem: `Enter the ${form.runsIn === 'container' ? 'container' : 'Compose service'} name (letters, digits, "_", "." and "-").` };
	}
	const mainBranches = form.mainBranches.map((branch) => branch.trim()).filter(Boolean);
	if (mainBranches.length === 0) {
		return { problem: 'Enter at least one main branch.' };
	}
	// Extra URL variables (e.g. an admin URL) keep following the first one.
	const otherVariables = current.database.urlVariables.slice(1).filter((variable) => variable !== urlVariable);
	return {
		values: {
			'database.engine': form.engine,
			envFile: form.envFile.trim() || current.envFile,
			'database.urlVariables': [urlVariable || current.database.urlVariables[0], ...otherVariables],
			'database.dockerContainer': form.runsIn === 'container' ? dockerName : '',
			'database.dockerComposeService': form.runsIn === 'compose' ? dockerName : '',
			'database.sqliteFolder': form.sqliteFolder.trim(),
			'database.mainBranches': mainBranches,
		},
	};
}

/** Checks a URL typed into the panel; returns a problem or undefined. */
export function urlProblem(url: string, engine: DatabaseEngineKind): string | undefined {
	const text = url.trim();
	if (!text) {
		return 'Enter the connection URL.';
	}
	const sqlite = isSqliteUrl(text);
	if (engine === 'sqlite' && !sqlite) {
		return 'That isn\'t a SQLite URL. Use e.g. sqlite:///data/app.db, file:./dev.db or a path ending in .db.';
	}
	if (engine === 'postgres' && sqlite) {
		return 'That\'s a SQLite URL, but the engine is PostgreSQL.';
	}
	if (!sqlite) {
		try {
			if (!parseDbUrl(text).database) {
				return 'The URL needs a database name at the end, e.g. postgresql://user:password@localhost:5432/app.';
			}
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}
	return undefined;
}

// ── Scripts ──────────────────────────────────────────────────────────────────

/** Adds `script` (no `originalId`) or replaces the one with `originalId`. Returns the new list or a problem. */
export function upsertScript(scripts: readonly ScriptDefinition[], script: ScriptDefinition, originalId?: string): ScriptDefinition[] | string {
	const label = script.label.trim();
	if (!label) {
		return 'Give the script a name.';
	}
	const steps = script.steps
		.map((step) => ({ ...step, label: step.label.trim() }))
		.filter((step) => ('run' in step ? step.run.trim() : step.copyFile.from.trim() && step.copyFile.to.trim()));
	if (steps.length === 0) {
		return 'Add at least one step with a command (or a file copy with both paths).';
	}
	const others = scripts.filter((item) => item.id !== originalId);
	const id = originalId ?? uniqueId(slug(label), new Set(others.map((item) => item.id)));
	const inputs = Object.fromEntries(Object.entries(script.inputs).filter(([name, input]) => name.trim() && input.options.length > 0));
	const cwd = cleanFolder(script.cwd ?? '');
	const runOn = cleanTriggers(script.runOn);
	const cleaned: ScriptDefinition = {
		id,
		label,
		icon: script.icon.trim() || 'play',
		...(cwd ? { cwd } : {}),
		...(runOn ? { runOn } : {}),
		env: Object.fromEntries(Object.entries(script.env).filter(([key]) => key.trim())),
		inputs,
		steps: steps.map((step) => ('run' in step
			? { label: step.label || step.run.trim(), run: step.run.trim() }
			: { label: step.label || `Copy ${step.copyFile.from} → ${step.copyFile.to}`, copyFile: { ...step.copyFile } })),
	};
	if (originalId === undefined) {
		return [...scripts, cleaned];
	}
	return scripts.some((item) => item.id === originalId)
		? scripts.map((item) => (item.id === originalId ? cleaned : item))
		: [...scripts, cleaned];
}

export function deleteScript(scripts: readonly ScriptDefinition[], id: string): ScriptDefinition[] {
	return scripts.filter((script) => script.id !== id);
}

export function moveScript(scripts: readonly ScriptDefinition[], id: string, delta: -1 | 1): ScriptDefinition[] {
	const list = [...scripts];
	const index = list.findIndex((script) => script.id === id);
	const target = index + delta;
	if (index < 0 || target < 0 || target >= list.length) {
		return list;
	}
	[list[index], list[target]] = [list[target], list[index]];
	return list;
}

// ── Servers ──────────────────────────────────────────────────────────────────

/**
 * Adds or replaces a configured server. Editing a server that only exists in launch.json adds a
 * configured one pointing at it (that's how it gets a run command).
 */
export function upsertServer(servers: readonly ServerDefinition[], form: PanelServerForm, originalId?: string): ServerDefinition[] | string {
	const label = form.label.trim();
	const command = form.command.trim();
	const debugConfiguration = form.debugConfiguration.trim();
	if (!label) {
		return 'Give the server a name.';
	}
	if (!command && !debugConfiguration) {
		return 'Enter a run command, pick a launch.json configuration, or both.';
	}
	const configured = servers.find((server) => server.id === originalId);
	const others = servers.filter((server) => server !== configured);
	const id = configured?.id ?? uniqueId(slug(label), new Set(others.map((server) => server.id)));
	const cwd = cleanFolder(form.cwd);
	const server: ServerDefinition = {
		id,
		label,
		command,
		debugConfiguration,
		restartOnDatabaseChange: form.restartOnDatabaseChange,
		...(cwd ? { cwd } : {}),
		...(form.runOnStartup ? { runOnStartup: true } : {}),
	};
	return configured ? servers.map((item) => (item === configured ? server : item)) : [...servers, server];
}

export function deleteServer(servers: readonly ServerDefinition[], id: string): ServerDefinition[] {
	return servers.filter((server) => server.id !== id);
}

/** Servers as stored values (without the `source` the merge adds). */
export function serverValues(servers: readonly ServerDefinition[]): Record<string, unknown> {
	return {
		servers: servers.map(({ id, label, command, debugConfiguration, restartOnDatabaseChange, cwd, runOnStartup }) => ({
			id,
			label,
			command,
			debugConfiguration,
			restartOnDatabaseChange,
			...(cwd ? { cwd } : {}),
			...(runOnStartup ? { runOnStartup: true } : {}),
		})),
		'server.command': '',
		'server.debugConfiguration': '',
	};
}

// ── Migrations ───────────────────────────────────────────────────────────────

/** Turns the Migrations form into stored values, or a problem. */
export function migrationValues(form: PanelMigrations): Record<string, unknown> | string {
	const streams = form.streams.map((stream) => ({
		name: stream.name.trim(),
		versionQuery: stream.versionQuery.trim(),
		versionsPath: cleanFolder(stream.versionsPath),
		downgradeCommand: stream.downgradeCommand.trim(),
		cwd: cleanFolder(stream.cwd) || '.',
	}));
	const incomplete = streams.findIndex((stream) => !stream.versionQuery || !stream.versionsPath || !stream.downgradeCommand);
	if (incomplete >= 0) {
		return `Migration history ${incomplete + 1} needs the version query, the versions folder and the downgrade command.`;
	}
	if (streams.some((stream) => !stream.downgradeCommand.includes('${revision}'))) {
		return 'Each downgrade command needs ${revision}, the revision to go back to (e.g. alembic downgrade ${revision}).';
	}
	return {
		'migrations.command': form.command.trim(),
		'migrations.cwd': cleanFolder(form.cwd),
		'migrations.onBranchChange': form.onBranchChange,
		'migrations.afterCopy': form.afterCopy,
		'migrations.streams': streams.map((stream, index) => ({ ...stream, name: stream.name || `history ${index + 1}` })),
	};
}

// ── Add defaults ─────────────────────────────────────────────────────────────

/** Suggestions for one tab, marking the ones already there. */
export function panelSuggestions(suggestions: readonly Suggestion[], config: Config, servers: readonly ServerDefinition[], tab: 'servers' | 'scripts'): PanelSuggestion[] {
	return suggestions
		.filter((item) => (tab === 'servers' ? item.kind === 'server' : item.kind !== 'server'))
		.map((item) => ({ id: item.id, kind: item.kind, label: item.label, detail: item.detail, exists: suggestionExists(item, config, servers) }));
}

function suggestionExists(item: Suggestion, config: Config, servers: readonly ServerDefinition[]): boolean {
	switch (item.kind) {
		case 'server':
			return servers.some((server) => server.label === item.server.label
				|| (item.server.command !== '' && server.command === item.server.command && (server.cwd ?? '') === (item.server.cwd ?? ''))
				|| (item.server.debugConfiguration !== '' && server.debugConfiguration === item.server.debugConfiguration));
		case 'script':
			return config.scripts.some((script) => script.label === item.script.label);
		case 'migrations':
			return config.migrations.command === item.command;
		case 'stream':
			return config.migrations.streams.some((stream) => stream.versionsPath === item.stream.versionsPath);
	}
}

/**
 * Stored values that add the picked suggestions. Servers and scripts are appended (with unique
 * ids); a migrations command replaces the current one; streams are appended.
 */
export function suggestionValues(suggestions: readonly Suggestion[], ids: readonly string[], config: Config, tab: 'servers' | 'scripts'): Record<string, unknown> {
	const picked = suggestions.filter((item) => ids.includes(item.id));
	if (tab === 'servers') {
		let servers: ServerDefinition[] = [...config.servers];
		for (const item of picked) {
			if (item.kind === 'server') {
				const result = upsertServer(servers, { ...item.server, cwd: item.server.cwd ?? '', runOnStartup: item.server.runOnStartup ?? false });
				servers = typeof result === 'string' ? servers : result;
			}
		}
		return serverValues(servers);
	}
	let scripts: ScriptDefinition[] = [...config.scripts];
	const values: Record<string, unknown> = {};
	const streams = config.migrations.streams.map(({ name, versionQuery, versionsPath, downgradeCommand, cwd, env }) => ({ name, versionQuery, versionsPath, downgradeCommand, cwd, env }));
	let streamsChanged = false;
	for (const item of picked) {
		if (item.kind === 'script') {
			const result = upsertScript(scripts, { ...item.script, id: '' });
			scripts = typeof result === 'string' ? scripts : result;
		} else if (item.kind === 'migrations') {
			values['migrations.command'] = item.command;
			values['migrations.cwd'] = item.cwd;
		} else if (item.kind === 'stream') {
			streams.push({ ...item.stream, env: {} });
			streamsChanged = true;
		}
	}
	values.scripts = scripts;
	if (streamsChanged) {
		values['migrations.streams'] = streams;
	}
	return values;
}

/** Triggers that are on, or undefined when none is (patterns only matter with fileSave). */
function cleanTriggers(runOn: ScriptDefinition['runOn']): ScriptDefinition['runOn'] {
	const clean = (list: string[] | undefined) => (list ?? []).map((pattern) => pattern.trim()).filter(Boolean);
	const patterns = clean(runOn?.fileSavePatterns);
	const gitPatterns = clean(runOn?.gitUpdatePatterns);
	const cleaned = {
		...(runOn?.startup ? { startup: true } : {}),
		...(runOn?.branchChange ? { branchChange: true } : {}),
		...(runOn?.fileSave ? { fileSave: true } : {}),
		...(runOn?.fileSave && patterns.length ? { fileSavePatterns: patterns } : {}),
		...(runOn?.gitUpdate ? { gitUpdate: true } : {}),
		...(runOn?.gitUpdate && gitPatterns.length ? { gitUpdatePatterns: gitPatterns } : {}),
	};
	return Object.keys(cleaned).length ? cleaned : undefined;
}

/** Stored values with no migrations: no Run Migrations or Sync Migrations buttons. */
export const NO_MIGRATIONS: Record<string, unknown> = { 'migrations.command': '', 'migrations.cwd': '', 'migrations.streams': [] };

/** A workspace-relative folder: trimmed, `/` separators, no leading `./` or trailing `/`. */
function cleanFolder(folder: string): string {
	return folder.trim().replace(/\\/g, '/').replace(/^\.(\/|$)/, '').replace(/\/+$/, '');
}

function slug(label: string): string {
	return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
	if (!taken.has(base)) {
		return base;
	}
	for (let index = 2; ; index++) {
		if (!taken.has(`${base}-${index}`)) {
			return `${base}-${index}`;
		}
	}
}
