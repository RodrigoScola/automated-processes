import { pipeProcesses, ProcessError, ProcessResult, ProcessSpec, runProcess } from './process';

// ── Engine interface ─────────────────────────────────────────────────────────

export interface DatabaseConnection {
	pid: number;
	application: string;
	client: string;
	user: string;
	state: string;
}

/** What the extension needs from a database server. PostgreSQL is the only implementation. */
export interface DatabaseEngine {
	listDatabases(): Promise<string[]>;
	connections(database: string): Promise<DatabaseConnection[]>;
	terminateConnections(database: string): Promise<number>;
	createEmpty(database: string): Promise<void>;
	/** Fast copy. Fails when anything is connected to `template`. */
	createFromTemplate(database: string, template: string): Promise<void>;
	/** Slow copy that works while `source` is in use. `target` must exist and be empty. */
	dumpRestore(source: string, target: string): Promise<void>;
	/** Per-database settings (`ALTER DATABASE … SET`) aren't copied by templates or dumps. */
	copySettings(source: string, target: string): Promise<void>;
	drop(database: string): Promise<void>;
}

// ── SQL helpers ──────────────────────────────────────────────────────────────

export function quoteIdent(identifier: string): string {
	return '"' + identifier.replace(/"/g, '""') + '"';
}

export function quoteLiteral(value: string): string {
	return "'" + value.replace(/'/g, "''") + "'";
}

/** Settings whose value is a list and must not be quoted as one string. */
const LIST_SETTINGS = new Set(['search_path', 'temp_tablespaces', 'session_preload_libraries', 'local_preload_libraries']);

/** `ALTER DATABASE … SET` for one `key=value` entry of `pg_db_role_setting.setconfig`. */
export function alterDatabaseSetSql(database: string, entry: string): string | undefined {
	const equals = entry.indexOf('=');
	if (equals <= 0) {
		return undefined;
	}
	const key = entry.slice(0, equals);
	const value = entry.slice(equals + 1);
	if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) {
		return undefined;
	}
	const rendered = LIST_SETTINGS.has(key.toLowerCase()) ? value : quoteLiteral(value);
	return `ALTER DATABASE ${quoteIdent(database)} SET ${key} TO ${rendered}`;
}

export const SQL = {
	listDatabases: 'SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname',
	connections: (database: string) =>
		'SELECT pid, coalesce(application_name, \'\'), coalesce(client_addr::text, \'local\'), coalesce(usename, \'\'), coalesce(state, \'\') ' +
		`FROM pg_stat_activity WHERE datname = ${quoteLiteral(database)} AND pid <> pg_backend_pid() ORDER BY pid`,
	terminate: (database: string) =>
		'SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity ' +
		`WHERE datname = ${quoteLiteral(database)} AND pid <> pg_backend_pid()`,
	createEmpty: (database: string) => `CREATE DATABASE ${quoteIdent(database)}`,
	createFromTemplate: (database: string, template: string) =>
		`CREATE DATABASE ${quoteIdent(database)} TEMPLATE ${quoteIdent(template)}`,
	settings: (database: string) =>
		'SELECT unnest(s.setconfig) FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase ' +
		`WHERE d.datname = ${quoteLiteral(database)} AND s.setrole = 0`,
	drop: (database: string) => `DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`,
};

// ── Client tools ─────────────────────────────────────────────────────────────

export type ClientTool = 'psql' | 'pg_dump' | 'pg_restore';

export interface ClientSettings {
	user: string;
	password: string;
	host: string;
	port?: number;
	/** Run tools inside this Docker Compose service instead of from PATH. */
	dockerComposeService?: string;
	/** Folder with the Compose file (Docker mode) or working folder. */
	cwd: string;
	processEnv: Record<string, string | undefined>;
}

/** Field separator for psql output; never appears in database names. */
export const FIELD_SEPARATOR = '\x1f';

/** Command line for one client tool, in Docker or locally. */
export function clientSpec(settings: ClientSettings, tool: ClientTool, args: string[]): ProcessSpec {
	if (settings.dockerComposeService) {
		const passwordArgs = settings.password ? ['-e', `PGPASSWORD=${settings.password}`] : [];
		return {
			command: 'docker',
			args: ['compose', 'exec', '-T', ...passwordArgs, settings.dockerComposeService, tool, '-U', settings.user, ...args],
			cwd: settings.cwd,
			env: settings.processEnv,
		};
	}
	const hostArgs = settings.host ? ['-h', settings.host] : [];
	const portArgs = settings.port ? ['-p', String(settings.port)] : [];
	return {
		command: tool,
		args: [...hostArgs, ...portArgs, '-U', settings.user, ...args],
		cwd: settings.cwd,
		env: { ...settings.processEnv, PGPASSWORD: settings.password },
	};
}

export function psqlArgs(database: string, sql: string): string[] {
	return ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', FIELD_SEPARATOR, '-d', database, '-c', sql];
}

export function parseRows(stdout: string): string[][] {
	return stdout
		.split(/\r?\n/)
		.filter((line) => line.length > 0)
		.map((line) => line.split(FIELD_SEPARATOR));
}

export type ProcessRunner = (spec: ProcessSpec) => Promise<ProcessResult>;
export type ProcessPiper = (from: ProcessSpec, to: ProcessSpec) => Promise<{ from: ProcessResult; to: ProcessResult }>;

const MAINTENANCE_DATABASE = 'postgres';

export class PostgresEngine implements DatabaseEngine {
	constructor(
		readonly settings: ClientSettings,
		private readonly run: ProcessRunner = runProcess,
		private readonly pipe: ProcessPiper = pipeProcesses,
	) {}

	async query(sql: string, database = MAINTENANCE_DATABASE): Promise<string[][]> {
		const result = await this.run(clientSpec(this.settings, 'psql', psqlArgs(database, sql)));
		if (result.code !== 0) {
			throw new ProcessError(describeFailure('psql', result), result);
		}
		return parseRows(result.stdout);
	}

	async listDatabases(): Promise<string[]> {
		return (await this.query(SQL.listDatabases)).map((row) => row[0]);
	}

	async connections(database: string): Promise<DatabaseConnection[]> {
		return (await this.query(SQL.connections(database))).map((row) => ({
			pid: Number(row[0]),
			application: row[1] ?? '',
			client: row[2] ?? '',
			user: row[3] ?? '',
			state: row[4] ?? '',
		}));
	}

	async terminateConnections(database: string): Promise<number> {
		const rows = await this.query(SQL.terminate(database));
		return Number(rows[0]?.[0] ?? 0);
	}

	async createEmpty(database: string): Promise<void> {
		await this.query(SQL.createEmpty(database));
	}

	async createFromTemplate(database: string, template: string): Promise<void> {
		await this.query(SQL.createFromTemplate(database, template));
	}

	async dumpRestore(source: string, target: string): Promise<void> {
		const dump = clientSpec(this.settings, 'pg_dump', ['--format=custom', '--no-password', '-d', source]);
		const restore = clientSpec(this.settings, 'pg_restore', ['--no-password', '--exit-on-error', '-d', target]);
		const { from, to } = await this.pipe(dump, restore);
		if (from.code !== 0) {
			throw new ProcessError(describeFailure('pg_dump', from), from);
		}
		if (to.code !== 0) {
			throw new ProcessError(describeFailure('pg_restore', to), to);
		}
	}

	async copySettings(source: string, target: string): Promise<void> {
		const entries = (await this.query(SQL.settings(source))).map((row) => row[0]);
		for (const entry of entries) {
			const sql = alterDatabaseSetSql(target, entry);
			if (sql) {
				await this.query(sql);
			}
		}
	}

	async drop(database: string): Promise<void> {
		await this.query(SQL.drop(database));
	}
}

export function describeFailure(tool: string, result: ProcessResult): string {
	const detail = result.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
	return `${tool} failed (exit code ${result.code})${detail ? `: ${detail}` : '.'}`;
}

/** True when CREATE DATABASE … TEMPLATE failed because the template is in use. */
export function isTemplateInUse(error: unknown): boolean {
	return error instanceof Error && /is being accessed by other users/i.test(error.message);
}
