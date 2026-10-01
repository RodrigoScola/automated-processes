import * as vscode from 'vscode';
import { ConfigResult, readConfig } from '../core/config';
import { SettingsWriter } from '../core/ports';

export const SECTION = 'automatedProcesses';

export function readSettings(folder: vscode.WorkspaceFolder | undefined): ConfigResult {
	const configuration = vscode.workspace.getConfiguration(SECTION, folder?.uri);
	return readConfig((key) => configuration.get(key));
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
