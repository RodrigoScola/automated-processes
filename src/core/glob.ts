/** Glob match supporting `*` (any run) and `?` (one character), anchored, case-sensitive. */
export function matchesGlob(value: string, pattern: string): boolean {
	const source = pattern
		.split('')
		.map((char) => {
			if (char === '*') {
				return '.*';
			}
			if (char === '?') {
				return '.';
			}
			return char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		})
		.join('');
	return new RegExp(`^${source}$`).test(value);
}

export function matchesAnyGlob(value: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) => matchesGlob(value, pattern));
}
