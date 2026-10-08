import * as vscode from 'vscode';
import { ConfigResult, LaunchConfiguration, mergeLaunchServers, readConfig } from '../core/config';
import { SettingsWriter } from '../core/ports';
import { SKIPPED_DEBUG_TYPES } from './environment';

export const SECTION = 'automatedProcesses';

/** Values set in the Configure panel, which win over settings.json. */
export interface OverrideValues {
	values(): Record<string, unknown>;
}

/**
 * The settings, with the Configure panel's values on top. Unless `mergeLaunch` is false, servers
 * are merged with launch.json (when `server.includeLaunchConfigurations` is on).
 */
export function readSettings(
	folder: vscode.WorkspaceFolder | undefined,
	overrides?: OverrideValues,
	options: { mergeLaunch?: boolean } = {},
): ConfigResult {
	const configuration = vscode.workspace.getConfiguration(SECTION, folder?.uri);
	const values = overrides?.values() ?? {};
	const result = readConfig((key) => (key in values ? values[key] : configuration.get(key)));
	if (options.mergeLaunch !== false && result.config.server.includeLaunchConfigurations) {
		result.config.servers = mergeLaunchServers(result.config.servers, launchServerConfigurations(folder));
	}
	return result;
}

/** launch.json configurations that can be servers: `launch` requests, not browsers or extension hosts. */
export function launchServerConfigurations(folder: vscode.WorkspaceFolder | undefined): LaunchConfiguration[] {
	const configurations = vscode.workspace.getConfiguration('launch', folder?.uri)
		.get<{ name?: unknown; type?: unknown; request?: unknown }[]>('configurations') ?? [];
	return configurations
		.filter((item) => typeof item.name === 'string' && item.name && item.request === 'launch'
			&& !(typeof item.type === 'string' && SKIPPED_DEBUG_TYPES.has(item.type)))
		.map((item) => ({ name: item.name as string }));
}

export class VsCodeSettings implements SettingsWriter {
	constructor(private readonly folder: vscode.WorkspaceFolder | undefined) {}

	async update(key: string, value: unknown): Promise<void> {
		const configuration = vscode.workspace.getConfiguration(SECTION, this.folder?.uri);
		const inspected = configuration.inspect(key);
		// Write where the value already lives; default to user settings so the repo isn't touched.
		const target = inspected?.workspaceFolderValue !== undefined
			? vscode.ConfigurationTarget.WorkspaceFolder
			: inspected?.workspaceValue !== undefined
				? vscode.ConfigurationTarget.Workspace
				: vscode.ConfigurationTarget.Global;
		await configuration.update(key, value, target);
	}

	open(): void {
		void vscode.commands.executeCommand('workbench.action.openSettings', SECTION);
	}
}
