import { Config } from './config';
import { databaseName, withDatabase } from './dbUrl';
import { EnvMap } from './envFile';
import { testDatabaseName } from './names';
import { PlaceholderContext, resolveAll } from './placeholders';

/** The env files of the project, as read from disk. */
export interface ProjectEnv {
	/** Variables from `envFile` (empty when the file is missing). */
	main: EnvMap;
	/** Variables from `testDatabase.envFile`, or the same as `main` when that's not set. */
	test: EnvMap;
}

export interface MainDatabase {
	name: string;
	url: string;
}

/** Main database from the first URL variable. Throws a readable error when it can't be found. */
export function mainDatabase(config: Config, env: ProjectEnv): MainDatabase {
	const variable = config.database.urlVariables[0];
	const url = variable ? env.main[variable] : undefined;
	if (!url) {
		throw new Error(`${variable ?? 'The database URL variable'} is not set in ${config.envFile}.`);
	}
	const name = databaseName(url);
	if (!name) {
		throw new Error(`${variable} in ${config.envFile} has no database name.`);
	}
	return { name, url };
}

export function testDatabasesEnabled(config: Config): boolean {
	return config.testDatabase.urlVariables.length > 0;
}

/** Test database used while `database` is current, or undefined when test databases are off. */
export function testDatabaseFor(config: Config, env: ProjectEnv, database: string, isMain: boolean): MainDatabase | undefined {
	if (!testDatabasesEnabled(config)) {
		return undefined;
	}
	const [first] = config.testDatabase.urlVariables;
	const baseUrl = env.test[first];
	if (!baseUrl) {
		return undefined;
	}
	if (isMain) {
		return { name: databaseName(baseUrl), url: baseUrl };
	}
	const name = testDatabaseName(database, config.testDatabase.nameSuffix);
	return { name, url: withDatabase(baseUrl, name) };
}

/**
 * Variables that point at `database`: every `database.urlVariables` entry (keeping each one's own
 * credentials when present in the env file) plus the test variables.
 */
export function databaseOverrides(config: Config, env: ProjectEnv, database: string, isMain: boolean): EnvMap {
	const overrides: EnvMap = {};
	const main = mainDatabase(config, env);
	for (const variable of config.database.urlVariables) {
		overrides[variable] = withDatabase(env.main[variable] || main.url, database);
	}
	if (testDatabasesEnabled(config)) {
		const [first] = config.testDatabase.urlVariables;
		const testBase = env.test[first];
		if (testBase) {
			for (const variable of config.testDatabase.urlVariables) {
				const base = env.test[variable] || testBase;
				overrides[variable] = isMain
					? base
					: withDatabase(base, testDatabaseName(database, config.testDatabase.nameSuffix));
			}
		}
	}
	return overrides;
}

export function placeholderContext(
	config: Config,
	env: ProjectEnv,
	processEnv: Record<string, string | undefined>,
	database: string,
	isMain: boolean,
	branch: string | undefined,
	inputs: Record<string, string> = {},
	extra: Record<string, string> = {},
): PlaceholderContext {
	const main = mainDatabase(config, env);
	const test = testDatabaseFor(config, env, database, isMain);
	return {
		db: { name: database, url: withDatabase(main.url, database), mainName: main.name, mainUrl: main.url },
		testDb: test,
		env: { ...processEnv, ...env.main },
		inputs,
		branch,
		extra,
	};
}

export interface CommandEnvOptions {
	processEnv: Record<string, string | undefined>;
	config: Config;
	env: ProjectEnv;
	database: string;
	isMain: boolean;
	branch: string | undefined;
	scriptEnv?: Record<string, string>;
	inputs?: Record<string, string>;
	/** Extra placeholders, e.g. `worktree`, `revision`. */
	extra?: Record<string, string>;
}

/**
 * Full environment for a command:
 * process env → env file (if `loadEnvFileIntoCommands`) → database URL overrides → `env` → script `env`.
 */
export function buildCommandEnv(options: CommandEnvOptions): EnvMap {
	const { config, env } = options;
	const context = placeholderContext(config, env, options.processEnv, options.database, options.isMain, options.branch, options.inputs, options.extra);
	const result: EnvMap = {};
	for (const [key, value] of Object.entries(options.processEnv)) {
		if (value !== undefined) {
			result[key] = value;
		}
	}
	if (config.loadEnvFileIntoCommands) {
		Object.assign(result, env.main);
	}
	Object.assign(result, databaseOverrides(config, env, options.database, options.isMain));
	Object.assign(result, resolveAll(config.env, context));
	Object.assign(result, resolveAll(options.scriptEnv ?? {}, context));
	return result;
}

/**
 * Only what the extension adds on top of the user's environment, for terminals and debug sessions.
 */
export function buildEnvAdditions(options: Omit<CommandEnvOptions, 'scriptEnv' | 'inputs' | 'extra'>): EnvMap {
	const { config, env } = options;
	const context = placeholderContext(config, env, options.processEnv, options.database, options.isMain, options.branch);
	return {
		...(config.loadEnvFileIntoCommands ? env.main : {}),
		...databaseOverrides(config, env, options.database, options.isMain),
		...resolveAll(config.env, context),
	};
}
