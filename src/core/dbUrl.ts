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

/** The same URL pointing at another database on the same server. */
export function withDatabase(url: string, database: string): string {
	const match = URL_PATTERN.exec(url.trim());
	if (!match) {
		throw new Error('Not a database URL (expected scheme://user:password@host:port/database).');
	}
	const [, scheme, authority, , rest] = match;
	return `${scheme}://${authority}/${encodeURIComponent(database)}${rest}`;
}

export function databaseName(url: string): string {
	return parseDbUrl(url).database;
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
