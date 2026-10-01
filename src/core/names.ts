/** PostgreSQL truncates identifiers longer than this many bytes. */
export const MAX_IDENTIFIER_LENGTH = 63;

/** Lowercase, `[a-z0-9_]` only, no repeated or edge underscores. */
export function sanitizeIdentifier(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_|_$/g, '');
}

/** Last path segment of a branch: `feature/add-login` → `add-login`. */
export function branchShort(branch: string): string {
	const segments = branch.split('/').filter(Boolean);
	return segments[segments.length - 1] ?? branch;
}

/** Leading issue number of a branch: `347-carer-leaver` → `347`, else undefined. */
export function branchIssue(branch: string): string | undefined {
	return /^(\d+)(?:\D|$)/.exec(branchShort(branch))?.[1];
}

/**
 * Suggest a database name from a pattern.
 * Placeholders: `{main}`, `{branch}`, `{branchShort}`, `{issue}` (falls back to `{branchShort}`).
 */
export function suggestDatabaseName(pattern: string, main: string, branch: string): string {
	const short = branchShort(branch);
	const values: Record<string, string> = {
		main,
		branch,
		branchShort: short,
		issue: branchIssue(branch) ?? short,
	};
	const filled = pattern.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
	return truncateIdentifier(sanitizeIdentifier(filled));
}

export function truncateIdentifier(name: string, maxLength = MAX_IDENTIFIER_LENGTH): string {
	return name.length <= maxLength ? name : name.slice(0, maxLength).replace(/_+$/, '');
}

/** Returns an error message, or undefined when the name is usable. */
export function validateDatabaseName(name: string): string | undefined {
	if (!name) {
		return 'Enter a name.';
	}
	if (name.length > MAX_IDENTIFIER_LENGTH) {
		return `Use at most ${MAX_IDENTIFIER_LENGTH} characters.`;
	}
	if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
		return 'Use lowercase letters, digits and underscores, starting with a letter or underscore.';
	}
	return undefined;
}

export function testDatabaseName(database: string, suffix: string): string {
	return database + suffix;
}
