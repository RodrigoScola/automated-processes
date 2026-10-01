import { BranchLink } from './store';

export interface CurrentDatabase {
	database: string;
	isMain: boolean;
	/** True when the branch has its own link (as opposed to falling back to main). */
	linked: boolean;
}

export function isMainBranch(branch: string | undefined, mainBranches: readonly string[]): boolean {
	return branch !== undefined && mainBranches.includes(branch);
}

/** The database a branch uses: its link if it has one, otherwise the main database. */
export function resolveCurrent(
	branch: string | undefined,
	links: Record<string, BranchLink>,
	mainName: string,
): CurrentDatabase {
	const link = branch ? links[branch] : undefined;
	if (link) {
		return { database: link.database, isMain: link.database === mainName, linked: true };
	}
	return { database: mainName, isMain: true, linked: false };
}

export interface MergedLink {
	branch: string;
	database: string;
	reason: 'merged' | 'deleted';
}

export interface MergedLinkInput {
	links: Record<string, BranchLink>;
	currentBranch: string | undefined;
	mainBranches: readonly string[];
	mainName: string;
	localBranches: ReadonlySet<string>;
	/** Branches whose tip is contained in a main branch (`git branch --merged`). */
	mergedBranches: ReadonlySet<string>;
	/** Current tip commit of each local branch. */
	tips: Readonly<Record<string, string>>;
}

/**
 * Linked branches whose work is finished: deleted locally, or merged into a main branch after
 * gaining commits since the link was made. A branch that hasn't moved since it was linked is
 * never "merged" (git reports brand-new branches as merged).
 * Never returns the current branch, main branches, or links to the main database.
 */
export function findFinishedLinks(input: MergedLinkInput): MergedLink[] {
	const result: MergedLink[] = [];
	for (const [branch, link] of Object.entries(input.links)) {
		if (branch === input.currentBranch || input.mainBranches.includes(branch) || link.database === input.mainName) {
			continue;
		}
		if (!input.localBranches.has(branch)) {
			result.push({ branch, database: link.database, reason: 'deleted' });
			continue;
		}
		const tip = input.tips[branch];
		const moved = !link.linkedAtCommit || (tip !== undefined && tip !== link.linkedAtCommit);
		if (input.mergedBranches.has(branch) && moved) {
			result.push({ branch, database: link.database, reason: 'merged' });
		}
	}
	return result;
}

/** Of `candidates`, the databases no remaining link still uses. */
export function databasesFreeAfterUnlink(
	candidates: readonly MergedLink[],
	links: Record<string, BranchLink>,
): string[] {
	const leaving = new Set(candidates.map((item) => item.branch));
	const stillUsed = new Set(
		Object.entries(links)
			.filter(([branch]) => !leaving.has(branch))
			.map(([, link]) => link.database),
	);
	return [...new Set(candidates.map((item) => item.database))].filter((db) => !stillUsed.has(db));
}
