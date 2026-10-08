import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { Config, ScriptDefinition, ServerDefinition } from '../core/config';
import {
	DATABASE_KEYS,
	databaseValues,
	deleteScript,
	deleteServer,
	moveScript,
	panelState,
	SCRIPT_KEYS,
	SERVER_KEYS,
	serverValues,
	upsertScript,
	upsertServer,
	urlProblem,
} from '../core/editor';
import { mainDatabase, ProjectEnv } from '../core/environment';
import { PanelHostMessage, PanelMessage, PanelNotice, PanelState, PanelTab } from '../shared/panelProtocol';
import { Overrides } from './overrides';
import { launchServerConfigurations, readSettings } from './settings';

export interface ConfigureDeps {
	extensionUri: vscode.Uri;
	folder: vscode.WorkspaceFolder | undefined;
	overrides: Overrides;
	readEnv(root: string, config: Config): ProjectEnv;
	/** Re-reads everything after a change; resolves once the database list is loaded again. */
	refresh(): Promise<void>;
	/** Database status after a refresh, for Test Connection. */
	connectionStatus(): { ok: boolean; message: string };
}

/**
 * The Configure editor tab: Database, Servers and Scripts, edited with forms. Changes are stored
 * in the extension (see `Overrides`) and apply right away.
 */
export class ConfigurePanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;

	constructor(private readonly deps: ConfigureDeps) {}

	show(tab: PanelTab = 'database'): void {
		if (this.panel) {
			this.panel.reveal();
			this.post({ type: 'show', tab });
			return;
		}
		const assets = vscode.Uri.joinPath(this.deps.extensionUri, 'dist', 'webview');
		const panel = vscode.window.createWebviewPanel('automatedProcesses.configure', 'Automated Processes: Configure', vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [assets],
		});
		panel.iconPath = vscode.Uri.joinPath(this.deps.extensionUri, 'media', 'icon.svg');
		panel.webview.html = html(panel.webview, assets, tab);
		panel.webview.onDidReceiveMessage((message: PanelMessage) => void this.handle(message));
		panel.onDidDispose(() => (this.panel = undefined));
		this.panel = panel;
	}

	/** Sends fresh state when the panel is open (after any settings or launch.json change). */
	update(): void {
		if (this.panel) {
			this.post({ type: 'state', state: this.state() });
		}
	}

	dispose(): void {
		this.panel?.dispose();
	}

	state(): PanelState {
		const { folder, overrides } = this.deps;
		const unmerged = readSettings(folder, overrides, { mergeLaunch: false });
		const merged = readSettings(folder, overrides);
		let mainUrl: string | undefined;
		if (folder) {
			try {
				mainUrl = mainDatabase(unmerged.config, this.deps.readEnv(folder.uri.fsPath, unmerged.config)).url;
			} catch {
				mainUrl = unmerged.config.database.url || undefined;
			}
		}
		return panelState({
			config: unmerged.config,
			servers: merged.config.servers,
			launchConfigurations: launchServerConfigurations(folder).map((item) => item.name),
			stored: overrides.stored(),
			mainUrl,
			urlStored: overrides.hasUrl,
			problems: unmerged.problems,
		});
	}

	private async handle(message: PanelMessage): Promise<void> {
		try {
			switch (message.type) {
				case 'ready':
					this.update();
					return;
				case 'saveDatabase':
					return await this.saveDatabase(message.form);
				case 'testConnection':
					await this.deps.refresh();
					return this.notice({ tab: 'database', ...toNotice(this.deps.connectionStatus()) });
				case 'saveServer':
					return await this.saveServers((servers) => upsertServer(servers, message.server, message.originalId), `Saved ${message.server.label.trim()}.`);
				case 'deleteServer': {
					const server = this.configured().servers.find((item) => item.id === message.id);
					if (server && await confirm(`Delete the server "${server.label}"?`, 'Its run and debug buttons go away. launch.json isn\'t changed.')) {
						await this.saveServers((servers) => deleteServer(servers, message.id), `Deleted ${server.label}.`);
					}
					return;
				}
				case 'setIncludeLaunch':
					await this.deps.overrides.set({ 'server.includeLaunchConfigurations': message.value });
					return await this.changed();
				case 'saveScript':
					return await this.saveScripts((scripts) => upsertScript(scripts, message.script, message.originalId), `Saved ${message.script.label.trim()}.`);
				case 'deleteScript': {
					const script = this.configured().scripts.find((item) => item.id === message.id);
					if (script && await confirm(`Delete the script "${script.label}"?`, 'Its button goes away from the sidebar.')) {
						await this.saveScripts((scripts) => deleteScript(scripts, message.id), `Deleted ${script.label}.`);
					}
					return;
				}
				case 'moveScript':
					return await this.saveScripts((scripts) => moveScript(scripts, message.id, message.delta));
				case 'reset':
					return await this.reset(message.tab);
				case 'open':
					return await this.open(message.target);
			}
		} catch (error) {
			const tab: PanelTab = message.type.toLowerCase().includes('script') ? 'scripts' : message.type.toLowerCase().includes('server') ? 'servers' : 'database';
			this.notice({ tab, kind: 'error', message: error instanceof Error ? error.message : String(error) });
		}
	}

	private configured(): Config {
		return readSettings(this.deps.folder, this.deps.overrides, { mergeLaunch: false }).config;
	}

	private async saveDatabase(form: Extract<PanelMessage, { type: 'saveDatabase' }>['form']): Promise<void> {
		const current = this.configured();
		const result = databaseValues(form, current);
		if ('problem' in result) {
			return this.notice({ tab: 'database', kind: 'error', message: result.problem });
		}
		if (form.source === 'url') {
			if (form.url !== undefined) {
				const problem = urlProblem(form.url, form.engine);
				if (problem) {
					return this.notice({ tab: 'database', kind: 'error', message: problem });
				}
			} else if (!this.deps.overrides.hasUrl) {
				return this.notice({ tab: 'database', kind: 'error', message: 'Enter the connection URL.' });
			}
		}
		await this.deps.overrides.set(result.values);
		if (form.source === 'envFile') {
			await this.deps.overrides.setUrl(undefined);
		} else if (form.url !== undefined) {
			await this.deps.overrides.setUrl(form.url.trim());
		}
		await this.deps.refresh();
		this.update();
		const status = this.deps.connectionStatus();
		this.notice({ tab: 'database', kind: status.ok ? 'ok' : 'error', message: `Saved. ${status.message}` }, true);
	}

	private async saveServers(change: (servers: ServerDefinition[]) => ServerDefinition[] | string, done: string): Promise<void> {
		const result = change(this.configured().servers);
		if (typeof result === 'string') {
			return this.notice({ tab: 'servers', kind: 'error', message: result });
		}
		await this.deps.overrides.set(serverValues(result));
		await this.changed();
		this.notice({ tab: 'servers', kind: 'ok', message: done }, true);
	}

	private async saveScripts(change: (scripts: ScriptDefinition[]) => ScriptDefinition[] | string, done?: string): Promise<void> {
		const result = change(this.configured().scripts);
		if (typeof result === 'string') {
			return this.notice({ tab: 'scripts', kind: 'error', message: result });
		}
		await this.deps.overrides.set({ scripts: result });
		await this.changed();
		if (done) {
			this.notice({ tab: 'scripts', kind: 'ok', message: done }, true);
		}
	}

	private async reset(tab: PanelTab): Promise<void> {
		const keys = tab === 'database' ? DATABASE_KEYS : tab === 'servers' ? SERVER_KEYS : SCRIPT_KEYS;
		const what = tab === 'database' ? 'the database connection (including an entered URL)' : `the ${tab}`;
		if (!await confirm(`Use settings.json for ${tab}?`, `Forgets ${what} saved here, so the automatedProcesses.* settings apply again.`)) {
			return;
		}
		await this.deps.overrides.clear(keys);
		if (tab === 'database') {
			await this.deps.overrides.setUrl(undefined);
		}
		await this.changed();
		this.notice({ tab, kind: 'ok', message: 'Now using settings.json.' }, true);
	}

	private async open(target: 'launchJson' | 'settings'): Promise<void> {
		if (target === 'settings') {
			await vscode.commands.executeCommand('workbench.action.openSettings', 'automatedProcesses');
			return;
		}
		const folder = this.deps.folder;
		if (!folder) {
			return;
		}
		const file = vscode.Uri.file(path.join(folder.uri.fsPath, '.vscode', 'launch.json'));
		try {
			await vscode.window.showTextDocument(file);
		} catch {
			// No launch.json yet: let VS Code create one.
			await vscode.commands.executeCommand('workbench.action.debug.configure');
		}
	}

	private async changed(): Promise<void> {
		await this.deps.refresh();
		this.update();
	}

	private notice(notice: PanelNotice, saved = false): void {
		this.post({ type: 'notice', notice, saved });
	}

	private post(message: PanelHostMessage): void {
		void this.panel?.webview.postMessage(message);
	}
}

function toNotice(status: { ok: boolean; message: string }): Pick<PanelNotice, 'kind' | 'message'> {
	return { kind: status.ok ? 'ok' : 'error', message: status.message };
}

async function confirm(message: string, detail: string): Promise<boolean> {
	const label = message.startsWith('Delete') ? 'Delete' : 'Continue';
	return (await vscode.window.showWarningMessage(message, { modal: true, detail }, label)) === label;
}

function html(webview: vscode.Webview, assets: vscode.Uri, tab: PanelTab): string {
	const nonce = crypto.randomBytes(16).toString('base64');
	const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(assets, file)).toString();
	const csp = [
		"default-src 'none'",
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`font-src ${webview.cspSource}`,
		`script-src 'nonce-${nonce}'`,
	].join('; ');
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${asset('codicon.css')}" id="vscode-codicon-stylesheet">
	<link rel="stylesheet" href="${asset('panel.css')}">
	<title>Configure</title>
</head>
<body data-tab="${tab}">
	<div id="app"></div>
	<script nonce="${nonce}" src="${asset('panel.js')}"></script>
</body>
</html>`;
}
