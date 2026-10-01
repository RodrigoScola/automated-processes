/** Typed view of the `automatedProcesses.*` settings. */

export type BranchChangeMode = 'off' | 'ask' | 'always';
export type MergedBranchMode = 'delete' | 'keep';
export type ServerRestartMode = 'restart' | 'ask' | 'off';

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

export interface Config {
	envFile: string;
	loadEnvFileIntoCommands: boolean;
	env: Record<string, string>;
	applyToTerminals: boolean;
	database: {
		urlVariables: string[];
		mainBranches: string[];
		dockerContainer: string;
		dockerComposeService: string;
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
	};
	server: {
		/** Command that runs the app's server in a terminal the extension owns. */
		command: string;
		/** What to do with running servers and debug sessions when the current database changes. */
		onDatabaseChange: ServerRestartMode;
	};
	scripts: ScriptDefinition[];
}

export const DEFAULT_CONFIG: Config = {
	envFile: '.env',
	loadEnvFileIntoCommands: true,
	env: {},
	applyToTerminals: true,
	database: {
		urlVariables: ['DATABASE_URL'],
		mainBranches: ['main'],
		dockerContainer: '',
		dockerComposeService: '',
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
	},
	server: {
		command: '',
		onDatabaseChange: 'restart',
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
		env: stringMap(read('env'), 'env', problems),
		applyToTerminals: bool(read('applyToTerminals'), d.applyToTerminals),
		database: {
			urlVariables: strList(read('database.urlVariables'), d.database.urlVariables),
			mainBranches: strList(read('database.mainBranches'), d.database.mainBranches),
			dockerContainer: str(read('database.dockerContainer'), d.database.dockerContainer, true),
			dockerComposeService: str(read('database.dockerComposeService'), d.database.dockerComposeService, true),
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
		},
		server: {
			command: str(read('server.command'), d.server.command, true),
			onDatabaseChange: oneOf(read('server.onDatabaseChange'), ['restart', 'ask', 'off'], d.server.onDatabaseChange),
		},
		scripts: readScripts(read('scripts'), problems),
	};
	return { config, problems };
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
