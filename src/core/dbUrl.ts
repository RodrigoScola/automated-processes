/**
 * Minimal database URL handling that keeps the original text intact
 * (driver suffixes like `postgresql+asyncpg`, query strings, encoding).
 */

const URL_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)(?:\/([^?#]*))?(.*)$/;

export interface DbUrlParts {
	scheme: string;
	user: string;
	password: string;
	host: string;
	port: number | undefined;
	database: string;
}

export function parseDbUrl(url: string): DbUrlParts {
	const match = URL_PATTERN.exec(url.trim());
	if (!match) {
		throw new Error('Not a database URL (expected scheme://user:password@host:port/database).');
	}
	const [, scheme, authority, path = ''] = match;
	const at = authority.lastIndexOf('@');
	const credentials = at >= 0 ? authority.slice(0, at) : '';
	const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
	const colon = credentials.indexOf(':');
	const user = colon >= 0 ? credentials.slice(0, colon) : credentials;
	const password = colon >= 0 ? credentials.slice(colon + 1) : '';
	const portMatch = /^(.*):(\d+)$/.exec(hostPort);
	return {
		scheme,
		user: safeDecode(user),
		password: safeDecode(password),
		host: portMatch ? portMatch[1] : hostPort,
		port: portMatch ? Number(portMatch[2]) : undefined,
		database: safeDecode(path),
	};
}

// ── SQLite ───────────────────────────────────────────────────────────────────
// A SQLite "database" is a file; its name is the file name without extension, and other
// databases of the same project are files with the same extension in the same folder.

/** `sqlite:///rel.db` / `sqlite:////abs.db` (SQLAlchemy), `sqlite:rel.db`, `file:./dev.db` (Prisma). */
const SQLITE_URL_PATTERN = /^(sqlite(?:\+[a-z0-9]+)?:(?:\/\/\/?)?|file:)([^?#]*)(.*)$/i;
const SQLITE_EXTENSIONS = /\.(db|db3|sqlite|sqlite3)$/i;

export interface SqliteUrlParts {
	/** Everything before the path, e.g. `sqlite:///`. */
	prefix: string;
	/** File path as written: relative to the project, or absolute. */
	path: string;
	/** Query string and anything after it. */
	suffix: string;
}

/** Parses a SQLite URL or a bare `.db` / `.sqlite` path; undefined for anything else. */
export function parseSqliteUrl(url: string): SqliteUrlParts | undefined {
	const text = url.trim();
	const match = SQLITE_URL_PATTERN.exec(text);
	if (match) {
		return { prefix: match[1], path: match[2], suffix: match[3] };
	}
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && SQLITE_EXTENSIONS.test(text.replace(/[?#].*$/, ''))) {
		const query = text.search(/[?#]/);
		return query < 0
			? { prefix: '', path: text, suffix: '' }
			: { prefix: '', path: text.slice(0, query), suffix: text.slice(query) };
	}
	return undefined;
}

export function isSqliteUrl(url: string): boolean {
	return parseSqliteUrl(url) !== undefined;
}

function splitFile(path: string): { folder: string; name: string; extension: string } {
	const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	const file = path.slice(slash + 1);
	const dot = file.lastIndexOf('.');
	return dot > 0
		? { folder: path.slice(0, slash + 1), name: file.slice(0, dot), extension: file.slice(dot) }
		: { folder: path.slice(0, slash + 1), name: file, extension: '' };
}

// ── Any engine ───────────────────────────────────────────────────────────────

/** The same URL pointing at another database on the same server (or another file next to it). */
export function withDatabase(url: string, database: string): string {
	const sqlite = parseSqliteUrl(url);
	if (sqlite) {
		const { folder, extension } = splitFile(sqlite.path);
		return `${sqlite.prefix}${folder}${database}${extension}${sqlite.suffix}`;
	}
	const match = URL_PATTERN.exec(url.trim());
	if (!match) {
		throw new Error('Not a database URL (expected scheme://user:password@host:port/database).');
	}
	const [, scheme, authority, , rest] = match;
	return `${scheme}://${authority}/${encodeURIComponent(database)}${rest}`;
}

export function databaseName(url: string): string {
	const sqlite = parseSqliteUrl(url);
	return sqlite ? splitFile(sqlite.path).name : parseDbUrl(url).database;
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
