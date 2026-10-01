/**
 * Finding migrations that were applied from another branch, and the revision to revert to.
 * Works on migration files as text; the default patterns match Alembic, and both are configurable.
 */

/** `revision = "abc"`, `revision: str = 'abc'` */
export const DEFAULT_REVISION_PATTERN = String.raw`^\s*revision\s*(?::[^=\n]+)?=\s*['"]([^'"]+)['"]`;
/** `down_revision = "abc"`, `= ("a", "b")`, `= None` (captures the whole right-hand side). */
export const DEFAULT_DOWN_REVISION_PATTERN = String.raw`^\s*down_revision\s*(?::[^=\n]+)?=\s*(.+)$`;

export interface MigrationNode {
	revision: string;
	/** Parents; empty for the first migration. */
	downRevisions: string[];
}

export interface RevisionPatterns {
	revision: string;
	downRevision: string;
}

/** Reads one migration file. Returns undefined when it has no revision id. */
export function parseMigration(text: string, patterns: RevisionPatterns): MigrationNode | undefined {
	const revision = new RegExp(patterns.revision, 'm').exec(text)?.[1];
	if (!revision) {
		return undefined;
	}
	const down = new RegExp(patterns.downRevision, 'm').exec(text)?.[1] ?? '';
	const downRevisions = [...down.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
	return { revision, downRevisions };
}

export type MigrationGraph = Map<string, MigrationNode>;

export function buildGraph(texts: string[], patterns: RevisionPatterns): MigrationGraph {
	const graph: MigrationGraph = new Map();
	for (const text of texts) {
		const node = parseMigration(text, patterns);
		if (node) {
			graph.set(node.revision, node);
		}
	}
	return graph;
}

export type RevertPlan =
	| { status: 'in-sync' }
	/** `target` is the revision to downgrade to (`base` when nothing is left). */
	| { status: 'revert'; foreign: string[]; target: string }
	| { status: 'error'; message: string };

/**
 * Applied revisions this branch doesn't have are "foreign". Walks the source branch's graph from
 * them through `down_revision` until it reaches revisions this branch knows; that's the target.
 */
export function planRevert(applied: string[], known: ReadonlySet<string>, source: MigrationGraph): RevertPlan {
	const heads = applied.filter((revision) => !known.has(revision));
	if (heads.length === 0) {
		return { status: 'in-sync' };
	}
	const foreign: string[] = [];
	const targets = new Set<string>();
	const seen = new Set<string>();
	const queue = [...heads];
	while (queue.length > 0) {
		const revision = queue.shift()!;
		if (seen.has(revision)) {
			continue;
		}
		seen.add(revision);
		if (known.has(revision)) {
			targets.add(revision);
			continue;
		}
		const node = source.get(revision);
		if (!node) {
			return { status: 'error', message: `Migration ${revision} isn't in this branch or in the branch it came from.` };
		}
		foreign.push(revision);
		if (node.downRevisions.length === 0) {
			targets.add('base');
		}
		queue.push(...node.downRevisions);
	}
	if (targets.size > 1) {
		return {
			status: 'error',
			message: `The foreign migrations go back to more than one revision this branch knows (${[...targets].join(', ')}). Revert them by hand.`,
		};
	}
	return { status: 'revert', foreign, target: [...targets][0] };
}
