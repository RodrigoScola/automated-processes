import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Config, ScriptDefinition, ServerDefinition } from '../core/config';
import { detectDefaults, nodeProjectFiles, Suggestion } from '../core/detect';
import {
	DATABASE_KEYS,
	databaseValues,
	deleteScript,
	deleteServer,
	migrationValues,
	NO_MIGRATIONS,
	moveScript,
	panelState,
	panelSuggestions,
	SCRIPT_KEYS,
	SERVER_KEYS,
	serverValues,
	suggestionValues,
	upsertScript,
	upsertServer,
	urlProblem,
} from '../core/editor';
import { mainDatabase, ProjectEnv } from '../core/environment';
import { PanelHostMessage, PanelMessage, PanelNotice, PanelState, PanelTab, Scope } from '../shared/panelProtocol';
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
 * The Configure editor tab: Database, Servers and Scripts (with migrations), edited with forms.
 * Changes are stored in the extension (see `Overrides`), for this workspace or for all of them,
 * and apply right away.
 */
export class ConfigurePanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	/** What the last "Add defaults" found, until it's added. */
	private suggestions: Suggestion[] = [];
	/** Add defaults to run once a just-opened panel is ready. */
	private iconNames: string[] | undefined;
	private pendingDetect: 'servers' | 'scripts' | undefined;

	constructor(private readonly deps: ConfigureDeps) {}

	/** Opens (or brings back) the panel on `tab`; `detect` also runs Add defaults there. */
	show(tab: PanelTab = 'database', detect = false): void {
		const detectTab = detect && tab !== 'database' ? tab : undefined;
		if (this.panel) {
			this.panel.reveal();
			this.post({ type: 'show', tab });
			if (detectTab) {
				this.detect(detectTab);
			}
			return;
		}
		// A new panel can't receive messages until its script has loaded; see 'ready'.
		this.pendingDetect = detectTab;
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
		const config = this.configured();
		let mainUrl: string | undefined;
		if (folder) {
			try {
				mainUrl = mainDatabase(config, this.deps.readEnv(folder.uri.fsPath, config)).url;
			} catch {
				mainUrl = config.database.url || undefined;
			}
		}
		return panelState({
			config,
			servers: readSettings(folder, overrides).config.servers,
			launchConfigurations: launchServerConfigurations(folder).map((item) => item.name),
			stored: { local: overrides.stored('local'), global: overrides.stored('global') },
			mainUrl,
			urlScope: overrides.urlScope(),
			problems: readSettings(folder, overrides, { mergeLaunch: false }).problems,
			icons: this.icons(),
		});
	}

	/** Codicon names, read once from the bundled codicon.css (`.codicon-NAME:before`). */
	private icons(): string[] {
		if (!this.iconNames) {
			try {
				const css = fs.readFileSync(path.join(this.deps.extensionUri.fsPath, 'dist', 'webview', 'codicon.css'), 'utf8');
				this.iconNames = [...new Set([...css.matchAll(/\.codicon-([a-z0-9-]+):before/g)].map((match) => match[1]))].sort();
			} catch {
				this.iconNames = [];
			}
		}
		return this.iconNames;
	}

	private async handle(message: PanelMessage): Promise<void> {
		try {
			switch (message.type) {
				case 'ready':
					this.update();
					if (this.pendingDetect) {
						this.detect(this.pendingDetect);
						this.pendingDetect = undefined;
					}
					return;
				case 'saveDatabase':
					return await this.saveDatabase(message.form, message.scope);
				case 'testConnection':
					await this.deps.refresh();
					return this.notice({ tab: 'database', ...toNotice(this.deps.connectionStatus()) });
				case 'saveServer':
					return await this.saveServers((servers) => upsertServer(servers, message.server, message.originalId), message.scope, `Saved ${message.server.label.trim()}.`);
				case 'addLaunch':
					return await this.saveServers(
						(servers) => upsertServer(servers, { label: message.name, command: '', debugConfiguration: message.name, restartOnDatabaseChange: true, cwd: '', runOnStartup: false }),
						message.scope,
						`Added ${message.name}. Edit it to give it a run command too.`,
					);
				case 'deleteServer': {
					const server = this.configured().servers.find((item) => item.id === message.id);
					if (server && await confirm(`Delete the server "${server.label}"?`, 'Its run and debug buttons go away. launch.json isn\'t changed.')) {
						await this.saveServers((servers) => deleteServer(servers, message.id), message.scope, `Deleted ${server.label}.`);
					}
					return;
				}
				case 'setIncludeLaunch':
					await this.deps.overrides.set({ 'server.includeLaunchConfigurations': message.value }, message.scope);
					return await this.changed();
				case 'saveScript':
					return await this.saveScripts((scripts) => upsertScript(scripts, message.script, message.originalId), message.scope, `Saved ${message.script.label.trim()}.`);
				case 'deleteScript': {
					const script = this.configured().scripts.find((item) => item.id === message.id);
					if (script && await confirm(`Delete the script "${script.label}"?`, 'Its button goes away from the sidebar.')) {
						await this.saveScripts((scripts) => deleteScript(scripts, message.id), message.scope, `Deleted ${script.label}.`);
					}
					return;
				}
				case 'moveScript':
					return await this.saveScripts((scripts) => moveScript(scripts, message.id, message.delta), message.scope);
				case 'removeMigrations':
					if (await confirm('Remove the migrations?', 'Run Migrations and Sync Migrations go away from the sidebar. The command and histories saved here are cleared.')) {
						await this.store(NO_MIGRATIONS, message.scope);
						this.notice({ tab: 'scripts', area: 'migrations', kind: 'ok', message: 'Removed the migrations.' }, true);
					}
					return;
				case 'saveMigrations': {
					const values = migrationValues(message.migrations);
					if (typeof values === 'string') {
						return this.notice({ tab: 'scripts', area: 'migrations', kind: 'error', message: values });
					}
					await this.store(values, message.scope);
					return this.notice({ tab: 'scripts', area: 'migrations', kind: 'ok', message: 'Saved the migrations.' }, true);
				}
				case 'detect':
					return this.detect(message.tab);
				case 'addSuggestions': {
					await this.store(suggestionValues(this.suggestions, message.ids, this.configured(), message.tab), message.scope);
					this.post({ type: 'suggestions', tab: message.tab, suggestions: [] });
					return this.notice({ tab: message.tab, kind: 'ok', message: `Added ${message.ids.length} item${message.ids.length === 1 ? '' : 's'}.` }, true);
				}
				case 'reset':
					return await this.reset(message.tab);
				case 'open':
					return await this.open(message.target);
			}
		} catch (error) {
			const type = message.type.toLowerCase();
			const tab: PanelTab = /script|migration/.test(type) ? 'scripts' : /server|launch/.test(type) ? 'servers' : 'database';
			this.notice({ tab, kind: 'error', message: error instanceof Error ? error.message : String(error) });
		}
	}

	/** Effective settings with the panel's values, servers not merged with launch.json. */
	private configured(): Config {
		return readSettings(this.deps.folder, this.deps.overrides, { mergeLaunch: false }).config;
	}

	private async saveDatabase(form: Extract<PanelMessage, { type: 'saveDatabase' }>['form'], scope: Scope): Promise<void> {
		const { overrides } = this.deps;
		const result = databaseValues(form, this.configured());
		if ('problem' in result) {
			return this.notice({ tab: 'database', kind: 'error', message: result.problem });
		}
		if (form.source === 'url') {
			if (form.url !== undefined) {
				const problem = urlProblem(form.url, form.engine);
				if (problem) {
					return this.notice({ tab: 'database', kind: 'error', message: problem });
				}
			} else if (!overrides.urlScope()) {
				return this.notice({ tab: 'database', kind: 'error', message: 'Enter the connection URL.' });
			}
		}
		await overrides.set(result.values, scope);
		if (form.source === 'envFile') {
			await overrides.clearUrl();
		} else if (form.url !== undefined) {
			await overrides.setUrl(form.url.trim(), scope);
		} else if (overrides.urlScope() !== scope) {
			// Same URL, moved to the other layer.
			const url = overrides.values()['database.url'] as string;
			await overrides.clearUrl();
			await overrides.setUrl(url, scope);
		}
		await this.changed();
		const status = this.deps.connectionStatus();
		this.notice({ tab: 'database', kind: status.ok ? 'ok' : 'error', message: `Saved${scope === 'global' ? ' for all workspaces' : ''}. ${status.message}` }, true);
	}

	private async saveServers(change: (servers: ServerDefinition[]) => ServerDefinition[] | string, scope: Scope, done: string): Promise<void> {
		const result = change(this.configured().servers);
		if (typeof result === 'string') {
			return this.notice({ tab: 'servers', kind: 'error', message: result });
		}
		await this.store(serverValues(result), scope);
		this.notice({ tab: 'servers', kind: 'ok', message: done }, true);
	}

	private async saveScripts(change: (scripts: ScriptDefinition[]) => ScriptDefinition[] | string, scope: Scope, done?: string): Promise<void> {
		const result = change(this.configured().scripts);
		if (typeof result === 'string') {
			return this.notice({ tab: 'scripts', kind: 'error', message: result });
		}
		await this.store({ scripts: result }, scope);
		if (done) {
			this.notice({ tab: 'scripts', kind: 'ok', message: done }, true);
		}
	}

	private detect(tab: 'servers' | 'scripts'): void {
		const folder = this.deps.folder;
		if (!folder) {
			return this.notice({ tab, kind: 'error', message: 'Open a folder first.' });
		}
		const launch = launchServerConfigurations(folder).map((item) => item.name);
		this.suggestions = detectDefaults(nodeProjectFiles(folder.uri.fsPath), launch);
		const config = this.configured();
		const found = panelSuggestions(this.suggestions, config, readSettings(folder, this.deps.overrides).config.servers, tab);
		this.post({ type: 'suggestions', tab, suggestions: found });
		if (found.length === 0) {
			this.notice({
				tab,
				kind: 'error',
				message: tab === 'servers'
					? 'Found nothing to run: no dev/start script in a package.json, no Django, FastAPI or Flask app, and no launch.json configuration.'
					: 'Found nothing: no package.json or Python project in the workspace or its direct subfolders.',
			});
		}
	}

	private async reset(tab: PanelTab): Promise<void> {
		const keys = tab === 'database' ? DATABASE_KEYS : tab === 'servers' ? SERVER_KEYS : SCRIPT_KEYS;
		const what = tab === 'database' ? 'the database connection (including an entered URL)' : tab === 'scripts' ? 'the scripts and migrations' : 'the servers';
		if (!await confirm(`Use settings.json for ${tab}?`, `Forgets ${what} saved here, for this workspace and for all workspaces, so the automatedProcesses.* settings apply again.`)) {
			return;
		}
		await this.deps.overrides.clear(keys);
		if (tab === 'database') {
			await this.deps.overrides.clearUrl();
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

	private async store(values: Record<string, unknown>, scope: Scope): Promise<void> {
		await this.deps.overrides.set(values, scope);
		await this.changed();
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
	const label = message.startsWith('Delete') ? 'Delete' : message.startsWith('Remove') ? 'Remove' : 'Continue';
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
