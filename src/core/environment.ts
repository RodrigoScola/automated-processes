import { Config } from './config';
import { databaseName, isSqliteUrl, withDatabase } from './dbUrl';
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

/** The project has no database URL at all: fine for projects without a database. */
export class NoDatabaseError extends Error {}

export interface MainDatabase {
	name: string;
	url: string;
}

/**
 * Main database: the URL entered in the extension, else the first URL variable of the env file.
 * Throws a readable error when it can't be found or doesn't fit `database.engine`.
 */
export function mainDatabase(config: Config, env: ProjectEnv): MainDatabase {
	const variable = config.database.urlVariables[0];
	const url = config.database.url || (variable ? env.main[variable] : undefined);
	const source = config.database.url ? 'The connection URL' : `${variable} in ${config.envFile}`;
	if (!url) {
		throw new NoDatabaseError(`${variable ?? 'The database URL variable'} is not set in ${config.envFile}.`);
	}
	const sqlite = isSqliteUrl(url);
	if (config.database.engine === 'sqlite' && !sqlite) {
		throw new Error(`${source} isn't a SQLite URL (e.g. sqlite:///data/app.db, file:./dev.db or a path ending in .db), but the engine is SQLite.`);
	}
	if (config.database.engine === 'postgres' && sqlite) {
		throw new Error(`${source} is a SQLite URL, but the engine is PostgreSQL.`);
	}
	const name = databaseName(url);
	if (!name) {
		throw new Error(`${source} has no database name.`);
	}
	return { name, url };
}

/** The engine `url` needs: SQLite for SQLite URLs, PostgreSQL for everything else. */
export function engineKind(url: string): 'postgres' | 'sqlite' {
	return isSqliteUrl(url) ? 'sqlite' : 'postgres';
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
	config.database.urlVariables.forEach((variable, index) => {
		// A URL entered in the extension replaces the env file's main variable.
		const base = index === 0 && config.database.url ? main.url : env.main[variable] || main.url;
		overrides[variable] = withDatabase(base, database);
	});
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
 * Environment for a command when there's no database to point at (no URL configured, or no env
 * file): process env → env file (if any) → `env` → script `env`. `${db.*}` placeholders stay as
 * written.
 */
export function buildCommandEnvWithoutDatabase(options: Omit<CommandEnvOptions, 'database' | 'isMain' | 'env'> & { env?: ProjectEnv }): EnvMap {
	const envFile = options.env?.main ?? {};
	const context: PlaceholderContext = {
		env: { ...options.processEnv, ...envFile },
		inputs: options.inputs ?? {},
		branch: options.branch,
		extra: options.extra,
	};
	const result: EnvMap = {};
	for (const [key, value] of Object.entries(options.processEnv)) {
		if (value !== undefined) {
			result[key] = value;
		}
	}
	if (options.config.loadEnvFileIntoCommands) {
		Object.assign(result, envFile);
	}
	Object.assign(result, resolveAll(options.config.env, context));
	Object.assign(result, resolveAll(options.scriptEnv ?? {}, context));
	return result;
}

/**
 * Only what the extension adds on top of the user's environment, for terminals and debug sessions.
 * The env file is left out unless both `loadEnvFileIntoCommands` and `loadEnvFileIntoTerminals` are on.
 */
export function buildEnvAdditions(options: Omit<CommandEnvOptions, 'scriptEnv' | 'inputs' | 'extra'>): EnvMap {
	const { config, env } = options;
	const context = placeholderContext(config, env, options.processEnv, options.database, options.isMain, options.branch);
	return {
		...(config.loadEnvFileIntoCommands && config.loadEnvFileIntoTerminals ? env.main : {}),
		...databaseOverrides(config, env, options.database, options.isMain),
		...resolveAll(config.env, context),
	};
}
