/**
 * The Configure panel's logic, without VS Code: what it shows, and how its forms turn into stored
 * values. Stored values are setting keys (`scripts`, `database.engine`, …) kept in the extension's
 * workspace storage; they override the same keys in settings.json.
 */

import { Config, DatabaseEngineKind, ScriptDefinition, ServerDefinition } from './config';
import { isSqliteUrl, parseDbUrl, parseSqliteUrl } from './dbUrl';
import { PanelDatabase, PanelDatabaseForm, PanelServer, PanelState, RunsIn } from '../shared/panelProtocol';

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

export const SCRIPT_KEYS = ['scripts'] as const;

export interface PanelInputs {
	/** Effective config, servers not merged with launch.json. */
	config: Config;
	/** Servers as the sidebar shows them (merged with launch.json when that's on). */
	servers: ServerDefinition[];
	launchConfigurations: string[];
	/** Values stored in the extension (not the URL, which is a secret). */
	stored: Record<string, unknown>;
	/** The main URL in use, if it could be read (env file or stored), to detect the engine and preview. */
	mainUrl: string | undefined;
	urlStored: boolean;
	problems: string[];
}

export function panelState(inputs: PanelInputs): PanelState {
	const { config } = inputs;
	const storedAny = (keys: readonly string[]) => keys.some((key) => key in inputs.stored);
	return {
		database: panelDatabase(inputs),
		servers: inputs.servers.map((server): PanelServer => ({
			id: server.id,
			label: server.label,
			command: server.command,
			debugConfiguration: server.debugConfiguration,
			restartOnDatabaseChange: server.restartOnDatabaseChange,
			source: server.source ?? 'config',
		})),
		launchConfigurations: inputs.launchConfigurations,
		includeLaunchConfigurations: config.server.includeLaunchConfigurations,
		scripts: config.scripts,
		stored: {
			database: storedAny(DATABASE_KEYS) || inputs.urlStored,
			servers: storedAny(SERVER_KEYS),
			scripts: storedAny(SCRIPT_KEYS),
		},
		problems: inputs.problems,
	};
}

function panelDatabase(inputs: PanelInputs): PanelDatabase {
	const { database } = inputs.config;
	const runsIn: RunsIn = database.dockerContainer ? 'container' : database.dockerComposeService ? 'compose' : 'local';
	return {
		engine: database.engine,
		detectedEngine: inputs.mainUrl ? (isSqliteUrl(inputs.mainUrl) ? 'sqlite' : 'postgres') : undefined,
		source: inputs.urlStored ? 'url' : 'envFile',
		envFile: inputs.config.envFile,
		urlVariable: database.urlVariables[0] ?? 'DATABASE_URL',
		urlPreview: inputs.urlStored && inputs.mainUrl ? maskUrl(inputs.mainUrl) : undefined,
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
	const cleaned: ScriptDefinition = {
		id,
		label,
		icon: script.icon.trim() || 'play',
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

export interface ServerForm {
	label: string;
	command: string;
	debugConfiguration: string;
	restartOnDatabaseChange: boolean;
}

/**
 * Adds or replaces a configured server. Editing a server that only exists in launch.json adds a
 * configured one pointing at it (that's how it gets a run command).
 */
export function upsertServer(servers: readonly ServerDefinition[], form: ServerForm, originalId?: string): ServerDefinition[] | string {
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
	const server: ServerDefinition = { id, label, command, debugConfiguration, restartOnDatabaseChange: form.restartOnDatabaseChange };
	return configured ? servers.map((item) => (item === configured ? server : item)) : [...servers, server];
}

export function deleteServer(servers: readonly ServerDefinition[], id: string): ServerDefinition[] {
	return servers.filter((server) => server.id !== id);
}

/** Servers as stored values (without the `source` the merge adds). */
export function serverValues(servers: readonly ServerDefinition[]): Record<string, unknown> {
	return {
		servers: servers.map(({ id, label, command, debugConfiguration, restartOnDatabaseChange }) => ({ id, label, command, debugConfiguration, restartOnDatabaseChange })),
		'server.command': '',
		'server.debugConfiguration': '',
	};
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
