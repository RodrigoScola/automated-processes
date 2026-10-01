/** Subset of `vscode.Memento` so the store can be tested without VS Code. */
export interface KeyValueStore {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void>;
}

export interface BranchLink {
	database: string;
	linkedAt: string;
	/** Branch tip when the link was made; a branch that never moved isn't treated as merged. */
	linkedAtCommit?: string;
}

export interface DatabaseMeta {
	createdAt?: string;
	lastCopiedFrom?: string;
	lastCopiedAt?: string;
}

export interface StoreData {
	links: Record<string, BranchLink>;
	meta: Record<string, DatabaseMeta>;
	/** Database that was current before the current one. */
	previous?: string;
	/** Last database the extension made current, used to detect changes. */
	current?: string;
}

const KEY = 'automatedProcesses.state';

export class BranchStore {
	constructor(private readonly kv: KeyValueStore, private readonly now: () => Date = () => new Date()) {}

	data(): StoreData {
		const stored = this.kv.get<StoreData>(KEY);
		return {
			links: { ...(stored?.links ?? {}) },
			meta: { ...(stored?.meta ?? {}) },
			previous: stored?.previous,
			current: stored?.current,
		};
	}

	linkOf(branch: string): BranchLink | undefined {
		return this.data().links[branch];
	}

	branchesOf(database: string): string[] {
		return Object.entries(this.data().links)
			.filter(([, link]) => link.database === database)
			.map(([branch]) => branch);
	}

	async link(branch: string, database: string, commit?: string): Promise<void> {
		const data = this.data();
		data.links[branch] = { database, linkedAt: this.now().toISOString(), linkedAtCommit: commit };
		await this.save(data);
	}

	async unlink(branch: string): Promise<void> {
		const data = this.data();
		delete data.links[branch];
		await this.save(data);
	}

	/** Records `database` as current; the old current becomes `previous` when it differs. */
	async setCurrent(database: string): Promise<boolean> {
		const data = this.data();
		if (data.current === database) {
			return false;
		}
		if (data.current) {
			data.previous = data.current;
		}
		data.current = database;
		await this.save(data);
		return true;
	}

	meta(database: string): DatabaseMeta {
		return this.data().meta[database] ?? {};
	}

	async updateMeta(database: string, patch: DatabaseMeta): Promise<void> {
		const data = this.data();
		data.meta[database] = { ...data.meta[database], ...patch };
		await this.save(data);
	}

	nowIso(): string {
		return this.now().toISOString();
	}

	/** Removes every trace of a dropped database. */
	async forgetDatabase(database: string): Promise<void> {
		const data = this.data();
		for (const [branch, link] of Object.entries(data.links)) {
			if (link.database === database) {
				delete data.links[branch];
			}
		}
		delete data.meta[database];
		if (data.previous === database) {
			data.previous = undefined;
		}
		await this.save(data);
	}

	private async save(data: StoreData): Promise<void> {
		await this.kv.update(KEY, data);
	}
}

/** In-memory store for tests and as a fallback. */
export class MemoryKeyValueStore implements KeyValueStore {
	private readonly values = new Map<string, unknown>();

	get<T>(key: string): T | undefined {
		const value = this.values.get(key);
		return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as T);
	}

	async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
	}
}
