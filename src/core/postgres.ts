import { pipeProcesses, ProcessError, ProcessResult, ProcessSpec, runFromFile, runProcess, runToFile } from './process';

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
	/** Runs SQL against `database` (default: the maintenance database) and returns the rows. */
	query(sql: string, database?: string): Promise<string[][]>;
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
	/** Addresses the Docker database container publishes on every network interface (empty outside Docker). */
	exposedAddresses(): Promise<string[]>;
	/** Extension of the files `dumpToFile` writes, e.g. `.dump`. */
	readonly fileExtension: string;
	/** Writes a full copy of `database` (schema and data) to `file`. */
	dumpToFile(database: string, file: string): Promise<void>;
	/** Loads a file `dumpToFile` wrote into `database`, which must exist and be empty. */
	restoreFromFile(file: string, database: string): Promise<void>;
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
	/** Run tools inside this Docker container (`docker exec`). Takes precedence over the Compose service. */
	dockerContainer?: string;
	/** Run tools inside this Docker Compose service (`docker compose exec`) instead of from PATH. */
	dockerComposeService?: string;
	/** Folder with the Compose file (Docker mode) or working folder. */
	cwd: string;
	processEnv: Record<string, string | undefined>;
}

/** Field separator for psql output; never appears in database names. */
export const FIELD_SEPARATOR = '\x1f';

/** Command line for one client tool, in Docker or locally. */
export function clientSpec(settings: ClientSettings, tool: ClientTool, args: string[]): ProcessSpec {
	// `-e PGPASSWORD` without a value makes docker copy it from its own environment, so the
	// password never appears on a command line, where any process on the machine can read it.
	const passwordArgs = settings.password ? ['-e', 'PGPASSWORD'] : [];
	const dockerEnv = settings.password ? { ...settings.processEnv, PGPASSWORD: settings.password } : settings.processEnv;
	if (settings.dockerContainer) {
		// -i keeps stdin open so pg_restore can read a piped dump; no -t, output is captured.
		return {
			command: 'docker',
			args: ['exec', '-i', ...passwordArgs, settings.dockerContainer, tool, '-U', settings.user, ...args],
			cwd: settings.cwd,
			env: dockerEnv,
		};
	}
	if (settings.dockerComposeService) {
		return {
			command: 'docker',
			args: ['compose', 'exec', '-T', ...passwordArgs, settings.dockerComposeService, tool, '-U', settings.user, ...args],
			cwd: settings.cwd,
			env: dockerEnv,
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

/** Of `docker port` output (`5432/tcp -> 0.0.0.0:5432`), the addresses bound to every interface. */
export function parseExposedAddresses(stdout: string): string[] {
	return stdout
		.split(/\r?\n/)
		.map((line) => line.split('->')[1]?.trim() ?? '')
		.filter((address) => /^(0\.0\.0\.0|\[::\]|::):\d+$/.test(address));
}

export type ProcessRunner = (spec: ProcessSpec) => Promise<ProcessResult>;
export type ProcessPiper = (from: ProcessSpec, to: ProcessSpec) => Promise<{ from: ProcessResult; to: ProcessResult }>;
/** Runs a command with its output written to, or its input read from, a file. */
export interface FileRunner {
	toFile(spec: ProcessSpec, file: string): Promise<ProcessResult>;
	fromFile(spec: ProcessSpec, file: string): Promise<ProcessResult>;
}

const NODE_FILE_RUNNER: FileRunner = { toFile: runToFile, fromFile: runFromFile };

const MAINTENANCE_DATABASE = 'postgres';

export class PostgresEngine implements DatabaseEngine {
	constructor(
		readonly settings: ClientSettings,
		private readonly run: ProcessRunner = runProcess,
		private readonly pipe: ProcessPiper = pipeProcesses,
		private readonly files: FileRunner = NODE_FILE_RUNNER,
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

	readonly fileExtension = '.dump';

	/** pg_dump's custom format, streamed out of the tools (or the container) into the file. */
	async dumpToFile(database: string, file: string): Promise<void> {
		const result = await this.files.toFile(clientSpec(this.settings, 'pg_dump', ['--format=custom', '--no-password', '-d', database]), file);
		if (result.code !== 0) {
			throw new ProcessError(describeFailure('pg_dump', result), result);
		}
	}

	async restoreFromFile(file: string, database: string): Promise<void> {
		const result = await this.files.fromFile(clientSpec(this.settings, 'pg_restore', ['--no-password', '--exit-on-error', '--no-owner', '-d', database]), file);
		if (result.code !== 0) {
			throw new ProcessError(describeFailure('pg_restore', result), result);
		}
	}

	async exposedAddresses(): Promise<string[]> {
		const { dockerContainer, dockerComposeService, cwd, processEnv } = this.settings;
		const docker = (args: string[]) => this.run({ command: 'docker', args, cwd, env: processEnv });
		let container = dockerContainer;
		if (!container && dockerComposeService) {
			const ps = await docker(['compose', 'ps', '-q', dockerComposeService]);
			container = ps.code === 0 ? ps.stdout.trim().split(/\r?\n/)[0] : undefined;
		}
		if (!container) {
			return [];
		}
		const result = await docker(['port', container]);
		return result.code === 0 ? parseExposedAddresses(result.stdout) : [];
	}
}

export function describeFailure(tool: string, result: ProcessResult): string {
	const detail = result.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
	return `${tool} failed (exit code ${result.code})${detail ? `: ${detail}` : '.'}`;
}

/** True when a client tool or docker itself couldn't be started. */
export function isToolMissing(error: unknown): boolean {
	return error instanceof Error && /was not found/.test(error.message);
}

/** True when the docker CLI runs but can't reach the Docker engine (Docker Desktop not started). */
export function isDockerDown(error: unknown): boolean {
	return error instanceof Error
		&& /cannot connect to the docker daemon|is the docker daemon running|error during connect|dockerDesktopLinuxEngine|docker_engine/i.test(error.message);
}

/** True when Docker runs but the database container (or Compose service) is stopped. */
export function isContainerStopped(error: unknown): boolean {
	return error instanceof Error && /is not running/i.test(error.message) && !isDockerDown(error);
}

/** True when CREATE DATABASE … TEMPLATE failed because the template is in use. */
export function isTemplateInUse(error: unknown): boolean {
	return error instanceof Error && /is being accessed by other users/i.test(error.message);
}
