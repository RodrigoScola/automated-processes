export interface PlaceholderContext {
	db?: { name: string; url: string; mainName: string; mainUrl: string };
	testDb?: { name: string; url: string };
	env: Record<string, string | undefined>;
	inputs: Record<string, string>;
	branch?: string;
}

/**
 * Replaces `${db.name}`, `${db.url}`, `${db.mainName}`, `${db.mainUrl}`,
 * `${testDb.name}`, `${testDb.url}`, `${env:NAME}`, `${input:NAME}` and `${branch}`.
 * Unknown placeholders are left untouched so they stay visible in the command.
 */
export function resolvePlaceholders(template: string, context: PlaceholderContext): string {
	return template.replace(/\$\{([^}]+)\}/g, (whole, key: string) => {
		const value = lookup(key.trim(), context);
		return value === undefined ? whole : value;
	});
}

function lookup(key: string, context: PlaceholderContext): string | undefined {
	if (key.startsWith('env:')) {
		return context.env[key.slice(4)] ?? '';
	}
	if (key.startsWith('input:')) {
		return context.inputs[key.slice(6)];
	}
	switch (key) {
		case 'db.name': return context.db?.name;
		case 'db.url': return context.db?.url;
		case 'db.mainName': return context.db?.mainName;
		case 'db.mainUrl': return context.db?.mainUrl;
		case 'testDb.name': return context.testDb?.name;
		case 'testDb.url': return context.testDb?.url;
		case 'branch': return context.branch;
		default: return undefined;
	}
}

export function resolveAll(values: Record<string, string>, context: PlaceholderContext): Record<string, string> {
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) {
		resolved[key] = resolvePlaceholders(value, context);
	}
	return resolved;
}
