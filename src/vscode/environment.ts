import * as vscode from 'vscode';
import { EnvMap } from '../core/envFile';
import { EnvironmentSink } from '../core/ports';

/** Debug types that launch browsers, where process env doesn't apply. */
export const SKIPPED_DEBUG_TYPES = new Set(['chrome', 'msedge', 'pwa-chrome', 'pwa-msedge', 'pwa-extensionHost', 'extensionHost']);

/**
 * Puts the current database (and env file values) into new terminals through the
 * extension's environment variable collection, and into debug launches through a
 * debug configuration provider.
 */
export class VsCodeEnvironmentSink implements EnvironmentSink, vscode.DebugConfigurationProvider {
	private additions: EnvMap | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		const collection = context.environmentVariableCollection;
		// Values can include passwords from the env file; don't write them to workspace storage.
		collection.persistent = false;
		collection.clear();
	}

	/** What debug launches currently get; used when relaunching a session not from launch.json. */
	get current(): EnvMap | undefined {
		return this.additions;
	}

	apply(additions: EnvMap | undefined, options: { terminals: boolean; description: string }): void {
		this.additions = additions;
		const collection = this.context.environmentVariableCollection;
		collection.clear();
		if (!additions || !options.terminals) {
			collection.description = undefined;
			return;
		}
		for (const [key, value] of Object.entries(additions)) {
			collection.replace(key, value);
		}
		collection.description = `Automated Processes · ${options.description}`;
	}

	resolveDebugConfiguration(
		_folder: vscode.WorkspaceFolder | undefined,
		configuration: vscode.DebugConfiguration,
	): vscode.DebugConfiguration {
		if (!this.additions || configuration.request !== 'launch' || SKIPPED_DEBUG_TYPES.has(configuration.type)) {
			return configuration;
		}
		// Launch config's own `env` wins; ours wins over its `envFile`.
		configuration.env = { ...this.additions, ...(configuration.env ?? {}) };
		return configuration;
	}
}
