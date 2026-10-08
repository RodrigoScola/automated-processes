import * as fs from 'fs';
import * as path from 'path';
import { parseSqliteUrl } from './dbUrl';
import { ClientSettings, DatabaseConnection, DatabaseEngine, describeFailure, FIELD_SEPARATOR, parseRows, ProcessRunner } from './postgres';
import { ProcessError, runProcess } from './process';

export interface SqliteSettings {
	/** Absolute path of the main database file. */
	file: string;
	cwd: string;
	processEnv: Record<string, string | undefined>;
}

/** What the controller passes to `createEngine`, depending on the main URL. */
export type EngineSettings = ({ engine: 'postgres' } & ClientSettings) | ({ engine: 'sqlite' } & SqliteSettings);

/** Files SQLite keeps next to a database while it's in use. */
const COMPANION_SUFFIXES = ['-wal', '-shm', '-journal'];

/**
 * Absolute path of the file a SQLite URL points at. Relative paths are relative to `baseFolder`
 * (the workspace folder unless `database.sqliteFolder` says otherwise).
 */
export function sqliteFilePath(url: string, baseFolder: string): string {
	const parts = parseSqliteUrl(url);
	if (!parts || !parts.path) {
		throw new Error('Not a SQLite URL (expected sqlite:///path/app.db, file:./app.db or a path ending in .db).');
	}
	return path.resolve(baseFolder, parts.path);
}

/**
 * SQLite as a database "server": every database is a file with the main file's extension in the
 * main file's folder. Copies are file copies; `query` needs the `sqlite3` command line tool
 * (only Sync Migrations uses it).
 */
export class SqliteEngine implements DatabaseEngine {
	private readonly folder: string;
	private readonly extension: string;

	constructor(
		readonly settings: SqliteSettings,
		private readonly run: ProcessRunner = runProcess,
	) {
		this.folder = path.dirname(settings.file);
		this.extension = path.extname(settings.file);
	}

	fileOf(database: string): string {
		return path.join(this.folder, database + this.extension);
	}

	async query(sql: string, database = path.basename(this.settings.file, this.extension)): Promise<string[][]> {
		const result = await this.run({
			command: 'sqlite3',
			args: ['-batch', '-noheader', '-separator', FIELD_SEPARATOR, this.fileOf(database), sql],
			cwd: this.settings.cwd,
			env: this.settings.processEnv,
		});
		if (result.code !== 0) {
			throw new ProcessError(describeFailure('sqlite3', result), result);
		}
		return parseRows(result.stdout);
	}

	async listDatabases(): Promise<string[]> {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(this.folder, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				throw new Error(`The SQLite folder ${this.folder} doesn't exist.`);
			}
			throw error;
		}
		return entries
			.filter((entry) => entry.isFile() && path.extname(entry.name) === this.extension && this.extension !== '')
			.map((entry) => path.basename(entry.name, this.extension))
			.sort();
	}

	/** SQLite has no server to ask; other programs using the file aren't visible. */
	async connections(): Promise<DatabaseConnection[]> {
		return [];
	}

	async terminateConnections(): Promise<number> {
		return 0;
	}

	async createEmpty(database: string): Promise<void> {
		// An empty file is a valid, empty SQLite database.
		await fs.promises.writeFile(this.fileOf(database), '', { flag: 'wx' });
	}

	async createFromTemplate(database: string, template: string): Promise<void> {
		const target = this.fileOf(database);
		if (fs.existsSync(target)) {
			throw new Error(`database "${database}" already exists`);
		}
		await this.copyFiles(template, database);
	}

	/** Same as a template copy; the target was just created empty. */
	async dumpRestore(source: string, target: string): Promise<void> {
		await this.copyFiles(source, target);
	}

	/** Settings live inside the file, so the copy already has them. */
	async copySettings(): Promise<void> {}

	async drop(database: string): Promise<void> {
		const file = this.fileOf(database);
		for (const name of [file, ...COMPANION_SUFFIXES.map((suffix) => file + suffix)]) {
			await fs.promises.rm(name, { force: true });
		}
	}

	get fileExtension(): string {
		return this.extension;
	}

	/**
	 * A consistent single-file copy with `sqlite3 .backup` when the tool is there; otherwise the
	 * file plus its write-ahead log (`<file>-wal`), which SQLite reads back together.
	 */
	async dumpToFile(database: string, file: string): Promise<void> {
		const source = this.fileOf(database);
		if (!fs.existsSync(source)) {
			throw new Error(`${path.basename(source)} not found in ${this.folder}.`);
		}
		const backup = await this.run({ command: 'sqlite3', args: [source, `.backup '${file.replace(/'/g, "''")}'`], cwd: this.settings.cwd, env: this.settings.processEnv })
			.catch(() => undefined);
		if (backup?.code === 0) {
			return;
		}
		await fs.promises.copyFile(source, file);
		await fs.promises.rm(file + '-wal', { force: true });
		if (fs.existsSync(source + '-wal')) {
			await fs.promises.copyFile(source + '-wal', file + '-wal');
		}
	}

	async restoreFromFile(file: string, database: string): Promise<void> {
		const target = this.fileOf(database);
		await fs.promises.copyFile(file, target);
		for (const suffix of COMPANION_SUFFIXES) {
			await fs.promises.rm(target + suffix, { force: true });
		}
		if (fs.existsSync(file + '-wal')) {
			await fs.promises.copyFile(file + '-wal', target + '-wal');
		}
	}

	async exposedAddresses(): Promise<string[]> {
		return [];
	}

	/** Copies the file and its write-ahead log, so recent writes not yet checkpointed come along. */
	private async copyFiles(source: string, target: string): Promise<void> {
		const from = this.fileOf(source);
		const to = this.fileOf(target);
		if (!fs.existsSync(from)) {
			throw new Error(`${path.basename(from)} not found in ${this.folder}.`);
		}
		await fs.promises.copyFile(from, to);
		for (const suffix of COMPANION_SUFFIXES) {
			await fs.promises.rm(to + suffix, { force: true });
		}
		if (fs.existsSync(from + '-wal')) {
			await fs.promises.copyFile(from + '-wal', to + '-wal');
		}
	}
}
