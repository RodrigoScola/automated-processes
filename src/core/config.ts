/** Typed view of the `automatedProcesses.*` settings. */

import { DEFAULT_DOWN_REVISION_PATTERN, DEFAULT_REVISION_PATTERN } from './migrationSync';

export type BranchChangeMode = 'off' | 'ask' | 'always';
export type MergedBranchMode = 'delete' | 'keep';
export type ServerRestartMode = 'restart' | 'ask' | 'off';
/** `auto` picks SQLite for SQLite URLs (`sqlite:///…`, `file:…`, `*.db`) and PostgreSQL otherwise. */
export type DatabaseEngineKind = 'auto' | 'postgres' | 'sqlite';

export interface ScriptInput {
	options: string[];
	default: string;
}

export type ScriptStep =
	| { label: string; run: string }
	| { label: string; copyFile: { from: string; to: string; ifMissing: boolean } };

export interface ScriptDefinition {
	id: string;
	label: string;
	icon: string;
	env: Record<string, string>;
	inputs: Record<string, ScriptInput>;
	steps: ScriptStep[];
}

/** One migration history (e.g. an Alembic stream), used by Sync Migrations. */
export interface MigrationStream {
	name: string;
	/** SQL returning the applied revision ids, one per row, run against the current database. */
	versionQuery: string;
	/** Folder with the migration files, relative to the workspace folder. */
	versionsPath: string;
	/** Reverts to `${revision}`. Runs in a temporary checkout of the branch the migrations came from. */
	downgradeCommand: string;
	/** Working folder for the command, relative to the checkout root. */
	cwd: string;
	env: Record<string, string>;
	revisionPattern: string;
	downRevisionPattern: string;
}

export interface Config {
	envFile: string;
	loadEnvFileIntoCommands: boolean;
	/** Env file values also go to new terminals and debug sessions (with `loadEnvFileIntoCommands`). */
	loadEnvFileIntoTerminals: boolean;
	env: Record<string, string>;
	applyToTerminals: boolean;
	applyToDebugSessions: boolean;
	/** Print each command at the top of its terminal. */
	echoCommands: boolean;
	database: {
		engine: DatabaseEngineKind;
		/** Main database URL entered in the extension; empty = read it from the env file. */
		url: string;
		/** Folder relative SQLite paths are resolved against, relative to the workspace; empty = the workspace. */
		sqliteFolder: string;
		urlVariables: string[];
		mainBranches: string[];
		dockerContainer: string;
		dockerComposeService: string;
		/** Start a stopped database container without asking (on startup and Retry). */
		autoStartContainer: boolean;
		/** Warn when the database container publishes its port on every network interface. */
		warnIfPortExposed: boolean;
		hidePatterns: string[];
		newNamePattern: string;
		/** New Database copies the main database's data (and schema) into the new one. */
		importDataOnCreate: boolean;
		onBranchMerged: MergedBranchMode;
	};
	testDatabase: {
		envFile: string;
		urlVariables: string[];
		nameSuffix: string;
	};
	migrations: {
		command: string;
		onBranchChange: BranchChangeMode;
		afterCopy: boolean;
		streams: MigrationStream[];
	};
	server: {
		/** What to do with running servers and debug sessions when the current database changes. */
		onDatabaseChange: ServerRestartMode;
		/** Show launch.json configurations as servers with a debug button. */
		includeLaunchConfigurations: boolean;
	};
	/** Servers with run/debug buttons (`servers`, or the single legacy `server.command`). */
	servers: ServerDefinition[];
	/** A script to run when the current branch gets new commits (pull, merge, rebase). */
	onGitUpdate: {
		/** Id of a script in `scripts`; empty = off. */
		script: string;
		mode: BranchChangeMode;
		/** Only when one of these files (globs, repo-relative) changed; empty = on every update. */
		whenFilesChange: string[];
		skipMainBranches: boolean;
	};
	scripts: ScriptDefinition[];
}

export interface ServerDefinition {
	id: string;
	label: string;
	/** Runs the server in a terminal the extension owns; empty = debug only. */
	command: string;
	/** launch.json configuration the debug button starts; empty = no debug button. */
	debugConfiguration: string;
	/** Restart it when the current database changes (off for e.g. a frontend). */
	restartOnDatabaseChange: boolean;
	/** Where it comes from, once merged with launch.json (see `mergeLaunchServers`). */
	source?: 'config' | 'launch' | 'both';
}

/** A launch.json configuration, as far as servers care. */
export interface LaunchConfiguration {
	name: string;
}

/**
 * Servers from the settings merged with launch.json, launch.json first: every launch
 * configuration is a server with a debug button, and a configured server whose
 * `debugConfiguration` names one takes its place (adding its run command).
 */
export function mergeLaunchServers(servers: readonly ServerDefinition[], launch: readonly LaunchConfiguration[]): ServerDefinition[] {
	const merged: ServerDefinition[] = [];
	const used = new Set<string>();
	for (const configuration of launch) {
		const match = servers.find((server) => server.debugConfiguration === configuration.name && !used.has(server.id));
		if (match) {
			used.add(match.id);
			merged.push({ ...match, source: 'both' });
		} else if (!servers.some((server) => server.id === configuration.name) && !merged.some((server) => server.id === configuration.name)) {
			merged.push({ id: configuration.name, label: configuration.name, command: '', debugConfiguration: configuration.name, restartOnDatabaseChange: true, source: 'launch' });
		}
	}
	for (const server of servers) {
		if (!used.has(server.id)) {
			merged.push({ ...server, source: 'config' });
		}
	}
	return merged;
}

export const DEFAULT_CONFIG: Config = {
	envFile: '.env',
	loadEnvFileIntoCommands: true,
	loadEnvFileIntoTerminals: true,
	env: {},
	applyToTerminals: true,
	applyToDebugSessions: true,
	echoCommands: true,
	database: {
		engine: 'auto',
		url: '',
		sqliteFolder: '',
		urlVariables: ['DATABASE_URL'],
		mainBranches: ['main'],
		dockerContainer: '',
		dockerComposeService: '',
		autoStartContainer: true,
		warnIfPortExposed: true,
		hidePatterns: ['postgres'],
		newNamePattern: '{main}_{branchShort}',
		importDataOnCreate: true,
		onBranchMerged: 'delete',
	},
	testDatabase: {
		envFile: '',
		urlVariables: [],
		nameSuffix: '_test',
	},
	migrations: {
		command: '',
		onBranchChange: 'ask',
		afterCopy: true,
		streams: [],
	},
	server: {
		onDatabaseChange: 'restart',
		includeLaunchConfigurations: true,
	},
	servers: [],
	onGitUpdate: {
		script: '',
		mode: 'always',
		whenFilesChange: [],
		skipMainBranches: false,
	},
	scripts: [],
};

/** Reads one setting by dotted key, e.g. `database.urlVariables`. */
export type SettingReader = (key: string) => unknown;

export interface ConfigResult {
	config: Config;
	problems: string[];
}

export function readConfig(read: SettingReader): ConfigResult {
	const problems: string[] = [];
	const d = DEFAULT_CONFIG;

	const config: Config = {
		envFile: str(read('envFile'), d.envFile),
		loadEnvFileIntoCommands: bool(read('loadEnvFileIntoCommands'), d.loadEnvFileIntoCommands),
		loadEnvFileIntoTerminals: bool(read('loadEnvFileIntoTerminals'), d.loadEnvFileIntoTerminals),
		env: stringMap(read('env'), 'env', problems),
		applyToTerminals: bool(read('applyToTerminals'), d.applyToTerminals),
		applyToDebugSessions: bool(read('applyToDebugSessions'), d.applyToDebugSessions),
		echoCommands: bool(read('echoCommands'), d.echoCommands),
		database: {
			engine: oneOf(read('database.engine'), ['auto', 'postgres', 'sqlite'], d.database.engine),
			url: str(read('database.url'), d.database.url, true),
			sqliteFolder: str(read('database.sqliteFolder'), d.database.sqliteFolder, true),
			urlVariables: strList(read('database.urlVariables'), d.database.urlVariables),
			mainBranches: strList(read('database.mainBranches'), d.database.mainBranches),
			dockerContainer: dockerName(read('database.dockerContainer'), 'database.dockerContainer', problems),
			dockerComposeService: dockerName(read('database.dockerComposeService'), 'database.dockerComposeService', problems),
			autoStartContainer: bool(read('database.autoStartContainer'), d.database.autoStartContainer),
			warnIfPortExposed: bool(read('database.warnIfPortExposed'), d.database.warnIfPortExposed),
			hidePatterns: strList(read('database.hidePatterns'), d.database.hidePatterns, true),
			newNamePattern: str(read('database.newNamePattern'), d.database.newNamePattern),
			importDataOnCreate: bool(read('database.importDataOnCreate'), d.database.importDataOnCreate),
			onBranchMerged: oneOf(read('database.onBranchMerged'), ['delete', 'keep'], d.database.onBranchMerged),
		},
		testDatabase: {
			envFile: str(read('testDatabase.envFile'), d.testDatabase.envFile, true),
			urlVariables: strList(read('testDatabase.urlVariables'), d.testDatabase.urlVariables, true),
			nameSuffix: str(read('testDatabase.nameSuffix'), d.testDatabase.nameSuffix),
		},
		migrations: {
			command: str(read('migrations.command'), d.migrations.command, true),
			onBranchChange: oneOf(read('migrations.onBranchChange'), ['off', 'ask', 'always'], d.migrations.onBranchChange),
			afterCopy: bool(read('migrations.afterCopy'), d.migrations.afterCopy),
			streams: readStreams(read('migrations.streams'), problems),
		},
		server: {
			onDatabaseChange: oneOf(read('server.onDatabaseChange'), ['restart', 'ask', 'off'], d.server.onDatabaseChange),
			includeLaunchConfigurations: bool(read('server.includeLaunchConfigurations'), d.server.includeLaunchConfigurations),
		},
		servers: readServers(read('servers'), read('server.command'), read('server.debugConfiguration'), problems),
		onGitUpdate: {
			script: str(read('onGitUpdate.script'), d.onGitUpdate.script, true),
			mode: oneOf(read('onGitUpdate.mode'), ['off', 'ask', 'always'], d.onGitUpdate.mode),
			whenFilesChange: strList(read('onGitUpdate.whenFilesChange'), d.onGitUpdate.whenFilesChange, true),
			skipMainBranches: bool(read('onGitUpdate.skipMainBranches'), d.onGitUpdate.skipMainBranches),
		},
		scripts: readScripts(read('scripts'), problems),
	};
	if (config.onGitUpdate.script && !config.scripts.some((script) => script.id === config.onGitUpdate.script)) {
		problems.push(`onGitUpdate.script: no script with id "${config.onGitUpdate.script}" in scripts.`);
	}
	return { config, problems };
}

function readServers(raw: unknown, legacyCommand: unknown, legacyDebug: unknown, problems: string[]): ServerDefinition[] {
	if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) {
		const command = str(legacyCommand, '', true);
		const debugConfiguration = str(legacyDebug, '', true);
		return command || debugConfiguration
			? [{ id: 'server', label: 'Server', command, debugConfiguration, restartOnDatabaseChange: true }]
			: [];
	}
	if (!Array.isArray(raw)) {
		problems.push('servers must be a list.');
		return [];
	}
	const servers: ServerDefinition[] = [];
	const seen = new Set<string>();
	raw.forEach((item, index) => {
		const where = `servers[${index}]`;
		if (!isObject(item)) {
			problems.push(`${where} must be an object.`);
			return;
		}
		const label = str(item.label, '');
		const command = str(item.command, '', true);
		const debugConfiguration = str(item.debugConfiguration, '', true);
		if (!label || (!command && !debugConfiguration)) {
			problems.push(`${where} needs a "label" and a "command" or "debugConfiguration".`);
			return;
		}
		const id = str(item.id, label);
		if (seen.has(id)) {
			problems.push(`${where}: duplicate id "${id}".`);
			return;
		}
		seen.add(id);
		servers.push({ id, label, command, debugConfiguration, restartOnDatabaseChange: bool(item.restartOnDatabaseChange, true) });
	});
	return servers;
}

function readStreams(raw: unknown, problems: string[]): MigrationStream[] {
	if (raw === undefined || raw === null) {
		return [];
	}
	if (!Array.isArray(raw)) {
		problems.push('migrations.streams must be a list.');
		return [];
	}
	const streams: MigrationStream[] = [];
	raw.forEach((item, index) => {
		const where = `migrations.streams[${index}]`;
		if (!isObject(item)) {
			problems.push(`${where} must be an object.`);
			return;
		}
		const missing = ['versionQuery', 'versionsPath', 'downgradeCommand']
			.filter((key) => typeof item[key] !== 'string' || !(item[key] as string).trim());
		if (missing.length > 0) {
			problems.push(`${where} needs ${missing.map((key) => `"${key}"`).join(', ')}.`);
			return;
		}
		streams.push({
			name: str(item.name, `stream ${index + 1}`),
			versionQuery: (item.versionQuery as string).trim(),
			versionsPath: (item.versionsPath as string).trim(),
			downgradeCommand: (item.downgradeCommand as string).trim(),
			cwd: str(item.cwd, '.', true) || '.',
			env: stringMap(item.env, `${where}.env`, problems),
			revisionPattern: str(item.revisionPattern, DEFAULT_REVISION_PATTERN),
			downRevisionPattern: str(item.downRevisionPattern, DEFAULT_DOWN_REVISION_PATTERN),
		});
	});
	return streams;
}

function readScripts(raw: unknown, problems: string[]): ScriptDefinition[] {
	if (raw === undefined || raw === null) {
		return [];
	}
	if (!Array.isArray(raw)) {
		problems.push('scripts must be a list.');
		return [];
	}
	const scripts: ScriptDefinition[] = [];
	const seen = new Set<string>();
	raw.forEach((item, index) => {
		const where = `scripts[${index}]`;
		if (!isObject(item)) {
			problems.push(`${where} must be an object.`);
			return;
		}
		const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : undefined;
		const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : label;
		if (!id || !label) {
			problems.push(`${where} needs a "label".`);
			return;
		}
		if (seen.has(id)) {
			problems.push(`${where}: duplicate id "${id}".`);
			return;
		}
		const steps = readSteps(item.steps, where, problems);
		if (steps.length === 0) {
			problems.push(`${where} ("${label}") has no valid steps.`);
			return;
		}
		seen.add(id);
		scripts.push({
			id,
			label,
			icon: typeof item.icon === 'string' && item.icon ? item.icon : 'play',
			env: stringMap(item.env, `${where}.env`, problems),
			inputs: readInputs(item.inputs, where, problems),
			steps,
		});
	});
	return scripts;
}

function readSteps(raw: unknown, where: string, problems: string[]): ScriptStep[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const steps: ScriptStep[] = [];
	raw.forEach((step, index) => {
		const stepWhere = `${where}.steps[${index}]`;
		if (!isObject(step)) {
			problems.push(`${stepWhere} must be an object.`);
			return;
		}
		if (typeof step.run === 'string' && step.run.trim()) {
			steps.push({ label: labelOf(step, step.run), run: step.run });
			return;
		}
		const copy = step.copyFile;
		if (isObject(copy) && typeof copy.from === 'string' && typeof copy.to === 'string') {
			steps.push({
				label: labelOf(step, `Copy ${copy.from} → ${copy.to}`),
				copyFile: { from: copy.from, to: copy.to, ifMissing: copy.ifMissing !== false },
			});
			return;
		}
		problems.push(`${stepWhere} needs "run" or "copyFile": { "from", "to" }.`);
	});
	return steps;
}

function readInputs(raw: unknown, where: string, problems: string[]): Record<string, ScriptInput> {
	if (raw === undefined) {
		return {};
	}
	if (!isObject(raw)) {
		problems.push(`${where}.inputs must be an object.`);
		return {};
	}
	const inputs: Record<string, ScriptInput> = {};
	for (const [name, value] of Object.entries(raw)) {
		const options = isObject(value) && Array.isArray(value.options)
			? value.options.filter((option): option is string => typeof option === 'string')
			: [];
		if (options.length === 0) {
			problems.push(`${where}.inputs.${name} needs a non-empty "options" list.`);
			continue;
		}
		const fallback = isObject(value) && typeof value.default === 'string' ? value.default : '';
		inputs[name] = { options, default: options.includes(fallback) ? fallback : options[0] };
	}
	return inputs;
}

function labelOf(step: Record<string, unknown>, fallback: string): string {
	return typeof step.label === 'string' && step.label.trim() ? step.label.trim() : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback: string, allowEmpty = false): string {
	if (typeof value !== 'string') {
		return fallback;
	}
	const trimmed = value.trim();
	return trimmed || allowEmpty ? trimmed : fallback;
}

/**
 * A container or Compose service name. These end up in `docker` command lines (one of them run
 * through a shell), so anything but Docker's name characters is rejected rather than run.
 */
function dockerName(value: unknown, where: string, problems: string[]): string {
	const name = str(value, '', true);
	if (name && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
		problems.push(`${where}: "${name}" isn't a valid name (letters, digits, "_", "." and "-", starting with a letter or digit). Ignored.`);
		return '';
	}
	return name;
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function strList(value: unknown, fallback: string[], allowEmpty = false): string[] {
	if (!Array.isArray(value)) {
		return [...fallback];
	}
	const list = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
	return list.length > 0 || allowEmpty ? list : [...fallback];
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return allowed.includes(value as T) ? (value as T) : fallback;
}

function stringMap(value: unknown, where: string, problems: string[]): Record<string, string> {
	if (value === undefined || value === null) {
		return {};
	}
	if (!isObject(value)) {
		problems.push(`${where} must be an object of strings.`);
		return {};
	}
	const map: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
			map[key] = String(item);
		} else {
			problems.push(`${where}.${key} must be a string.`);
		}
	}
	return map;
}
