import * as vscode from 'vscode';
import { Scope } from '../shared/panelProtocol';

const KEY = 'automatedProcesses.overrides';
const SECRET = 'automatedProcesses.database.url';

/**
 * Settings changed in the Configure panel, in two layers on this machine: `global` (every
 * workspace, in the extension's global storage) and `local` (this workspace only), local winning.
 * Both override the same `automatedProcesses.*` keys from settings.json. A connection URL entered
 * there holds a password, so it goes to VS Code's secret storage instead and is cached here,
 * because settings are read synchronously.
 */
export class Overrides {
	private readonly urls: Record<Scope, string | undefined> = { local: undefined, global: undefined };
	private readonly secretKeys: Record<Scope, string>;

	constructor(
		private readonly states: Record<Scope, vscode.Memento>,
		private readonly secrets: vscode.SecretStorage,
		folder: vscode.WorkspaceFolder | undefined,
	) {
		this.secretKeys = { local: `${SECRET}:${folder?.uri.toString() ?? ''}`, global: SECRET };
	}

	async load(): Promise<void> {
		this.urls.local = await this.secrets.get(this.secretKeys.local);
		this.urls.global = await this.secrets.get(this.secretKeys.global);
	}

	/** Values stored in one layer, without the URL. */
	stored(scope: Scope): Record<string, unknown> {
		return { ...(this.states[scope].get<Record<string, unknown>>(KEY) ?? {}) };
	}

	/** Everything that overrides settings.json: global, then local, the URL included. */
	values(): Record<string, unknown> {
		const values = { ...this.stored('global'), ...this.stored('local') };
		const url = this.urls.local ?? this.urls.global;
		return url ? { ...values, 'database.url': url } : values;
	}

	/** The layer the URL in use comes from. */
	urlScope(): Scope | undefined {
		return this.urls.local ? 'local' : this.urls.global ? 'global' : undefined;
	}

	/**
	 * Stores values in a layer. Saving for every workspace also forgets the same keys in this
	 * workspace's layer, or they would keep hiding the new values here.
	 */
	async set(values: Record<string, unknown>, scope: Scope = 'local'): Promise<void> {
		await this.states[scope].update(KEY, { ...this.stored(scope), ...values });
		if (scope === 'global') {
			await this.clear(Object.keys(values), 'local');
		}
	}

	/** Forgets keys in one layer, or both, so the next layer (or settings.json) applies again. */
	async clear(keys: readonly string[], scope?: Scope): Promise<void> {
		for (const layer of scope ? [scope] : (['local', 'global'] as const)) {
			const stored = this.stored(layer);
			keys.forEach((key) => delete stored[key]);
			await this.states[layer].update(KEY, stored);
		}
	}

	async setUrl(url: string | undefined, scope: Scope = 'local'): Promise<void> {
		if (url) {
			await this.secrets.store(this.secretKeys[scope], url);
		} else {
			await this.secrets.delete(this.secretKeys[scope]);
		}
		this.urls[scope] = url || undefined;
		if (url && scope === 'global') {
			await this.setUrl(undefined, 'local');
		}
	}

	/** Forgets the URL everywhere. */
	async clearUrl(): Promise<void> {
		await this.setUrl(undefined, 'local');
		await this.setUrl(undefined, 'global');
	}
}
