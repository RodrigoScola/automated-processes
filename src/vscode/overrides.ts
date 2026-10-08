import * as vscode from 'vscode';

const KEY = 'automatedProcesses.overrides';

/**
 * Settings changed in the Configure panel. They're kept in the extension's workspace storage
 * (on this machine, nothing in the repo) and override the same `automatedProcesses.*` keys from
 * settings.json. A connection URL entered there holds a password, so it goes to VS Code's secret
 * storage instead and is cached here, because settings are read synchronously.
 */
export class Overrides {
	private url: string | undefined;

	constructor(
		private readonly state: vscode.Memento,
		private readonly secrets: vscode.SecretStorage,
		folder: vscode.WorkspaceFolder | undefined,
	) {
		this.secretKey = `automatedProcesses.database.url:${folder?.uri.toString() ?? ''}`;
	}

	private readonly secretKey: string;

	async load(): Promise<void> {
		this.url = await this.secrets.get(this.secretKey);
	}

	/** Stored values without the URL. */
	stored(): Record<string, unknown> {
		return { ...(this.state.get<Record<string, unknown>>(KEY) ?? {}) };
	}

	/** Everything that overrides settings.json, the URL included. */
	values(): Record<string, unknown> {
		return this.url ? { ...this.stored(), 'database.url': this.url } : this.stored();
	}

	get hasUrl(): boolean {
		return Boolean(this.url);
	}

	async set(values: Record<string, unknown>): Promise<void> {
		await this.state.update(KEY, { ...this.stored(), ...values });
	}

	/** Forgets stored keys, so settings.json applies again. */
	async clear(keys: readonly string[]): Promise<void> {
		const stored = this.stored();
		keys.forEach((key) => delete stored[key]);
		await this.state.update(KEY, stored);
	}

	async setUrl(url: string | undefined): Promise<void> {
		if (url) {
			await this.secrets.store(this.secretKey, url);
		} else {
			await this.secrets.delete(this.secretKey);
		}
		this.url = url || undefined;
	}
}
