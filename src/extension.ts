import * as path from 'path';
import * as vscode from 'vscode';
import { Config } from './core/config';
import { Controller } from './core/controller';
import { readEnvFile } from './core/envFile';
import { ProjectEnv } from './core/environment';
import { PostgresEngine } from './core/postgres';
import { ScriptRunner } from './core/scriptRunner';
import { SqliteEngine } from './core/sqlite';
import { BranchStore } from './core/store';
import { WebviewMessage } from './shared/protocol';
import { ConfigurePanel } from './vscode/configurePanel';
import { VsCodeEnvironmentSink } from './vscode/environment';
import { Overrides } from './vscode/overrides';
import { VsCodeGit } from './vscode/git';
import { VsCodeServer } from './vscode/server';
import { readSettings, SECTION, VsCodeSettings } from './vscode/settings';
import { SIDEBAR_VIEW_ID, SidebarProvider } from './vscode/sidebar';
import { StatusBar } from './vscode/statusBar';
import { TaskExecutor } from './vscode/taskExecutor';
import { VsCodeUi } from './vscode/ui';

export const COMMAND_PREFIX = 'automated-processes';

export async function activate(context: vscode.ExtensionContext): Promise<Controller> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	const root = folder?.uri.fsPath;

	const overrides = new Overrides(context.workspaceState, context.secrets, folder);
	await overrides.load();
	const settings = () => readSettings(folder, overrides);
	const echoCommands = () => settings().config.echoCommands;
	const executor = new TaskExecutor(folder, echoCommands);
	const git = new VsCodeGit(root ?? '');
	const envSink = new VsCodeEnvironmentSink(context, folder);
	const statusBar = new StatusBar();
	let sidebar: SidebarProvider | undefined;
	const server = new VsCodeServer(folder, envSink, () => notify(), echoCommands);

	const controller: Controller = new Controller({
		ui: new VsCodeUi(),
		git,
		store: new BranchStore(context.workspaceState),
		prefs: context.workspaceState,
		settings: new VsCodeSettings(folder),
		envSink,
		scripts: new ScriptRunner(executor, () => notify()),
		readConfig: settings,
		root: () => root,
		readEnv,
		createEngine: (settings) => (settings.engine === 'sqlite' ? new SqliteEngine(settings) : new PostgresEngine(settings)),
		server,
		processEnv: process.env,
		onDidChange: () => notify(),
	});

	const panel = new ConfigurePanel({
		extensionUri: context.extensionUri,
		folder,
		overrides,
		readEnv,
		refresh: () => controller.refresh(),
		connectionStatus: () => {
			const state = controller.snapshot();
			if (state.dbStatus === 'ok') {
				const count = state.totalDatabases;
				return { ok: true, message: `Connected: ${count} database${count === 1 ? '' : 's'}, main is ${state.current?.mainName ?? '?'}.` };
			}
			return { ok: false, message: state.problems[0] ?? state.dbError ?? 'Couldn\'t connect.' };
		},
	});

	function notify(): void {
		const state = controller.snapshot();
		sidebar?.update();
		statusBar.update(state);
	}

	sidebar = new SidebarProvider(context.extensionUri, () => controller.snapshot(), (message) => void handleMessage(controller, executor, message));

	context.subscriptions.push(
		git,
		statusBar,
		server,
		vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.debug.registerDebugConfigurationProvider('*', envSink),
		panel,
		...registerCommands(controller, executor, panel),
		vscode.workspace.onDidChangeConfiguration((event) => {
			// launch.json configurations are servers too.
			if (event.affectsConfiguration(SECTION) || event.affectsConfiguration('launch')) {
				void controller.refresh().then(() => panel.update());
			}
		}),
	);

	if (root) {
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '.env*'));
		const onEnvChange = debounce(() => void controller.refresh(), 300);
		context.subscriptions.push(watcher, watcher.onDidChange(onEnvChange), watcher.onDidCreate(onEnvChange), watcher.onDidDelete(onEnvChange));

		const onGit = debounce(() => void controller.onGitStateChanged(), 200);
		const onGitSettled = debounce(() => void controller.checkFinishedBranches(), 3000);
		context.subscriptions.push(git.onDidChange(() => {
			onGit();
			onGitSettled();
		}));
		await git.initialize().catch(() => undefined);
	}

	await controller.start();
	return controller;
}

export function deactivate(): void {}

function readEnv(root: string, config: Config): ProjectEnv {
	const main = readEnvFile(root, config.envFile);
	if (!main) {
		// With a URL entered in the Configure panel, the env file is optional.
		if (config.database.url) {
			return { main: {}, test: config.testDatabase.envFile ? readEnvFile(root, config.testDatabase.envFile) ?? {} : {} };
		}
		throw new Error(`${config.envFile} not found in ${path.basename(root)}.`);
	}
	const test = config.testDatabase.envFile ? readEnvFile(root, config.testDatabase.envFile) ?? {} : main;
	return { main, test };
}

function registerCommands(controller: Controller, executor: TaskExecutor, panel: ConfigurePanel): vscode.Disposable[] {
	const commands: Record<string, (...args: unknown[]) => unknown> = {
		configure: (tab?: unknown) => panel.show(tab === 'servers' || tab === 'scripts' ? tab : 'database'),
		newDatabase: () => controller.newDatabase(),
		migrate: () => controller.migrate(),
		switchDatabase: (name?: unknown) => controller.switchDatabase(typeof name === 'string' ? name : undefined),
		switchBack: () => controller.switchBack(),
		removeDatabase: (name?: unknown) => controller.removeDatabase(typeof name === 'string' ? name : undefined),
		cleanUpDatabases: () => controller.cleanUpDatabases(),
		runMigrations: () => controller.runMigrations(),
		syncMigrations: () => controller.syncMigrations(),
		runScript: async (id?: unknown) => {
			const scriptId = typeof id === 'string' ? id : await pickScript(controller);
			if (scriptId) {
				await controller.runScript(scriptId);
			}
		},
		startDatabase: () => controller.startDatabase(),
		connectDatabase: () => controller.connectDatabase(),
		startServer: async (id?: unknown) => withServer(controller, id, 'Run which server?', (server) => controller.startServer(server)),
		debugServer: async (id?: unknown) => withServer(controller, id, 'Debug which server?', (server) => controller.debugServer(server)),
		stopServer: async (id?: unknown) => withServer(controller, id, 'Stop which server?', (server) => controller.stopServer(server)),
		// Without an id (palette, status row of other sessions) it restarts everything that runs.
		restartServer: (id?: unknown) => controller.restartServer(typeof id === 'string' ? id : undefined),
		refresh: () => controller.refresh(),
		openSettings: () => controller.openSettings(),
		cancelRun: () => controller.cancelRun(),
		showOutput: () => executor.showOutput(),
	};
	return Object.entries(commands).map(([name, handler]) =>
		vscode.commands.registerCommand(`${COMMAND_PREFIX}.${name}`, handler),
	);
}

/** Uses `id` when given, otherwise the only server, otherwise asks. */
async function withServer(controller: Controller, id: unknown, title: string, action: (server: string) => Promise<void>): Promise<void> {
	if (typeof id === 'string') {
		return action(id);
	}
	const servers = controller.snapshot().servers;
	if (servers.length === 0) {
		void vscode.window.showInformationMessage('No servers configured. Add them to automatedProcesses.servers.');
		return;
	}
	const picked = servers.length === 1
		? servers[0]
		: (await vscode.window.showQuickPick(servers.map((server) => ({ label: server.label, description: server.status, server })), { title }))?.server;
	if (picked) {
		await action(picked.id);
	}
}

async function pickScript(controller: Controller): Promise<string | undefined> {
	const scripts = controller.snapshot().scripts;
	if (scripts.length === 0) {
		void vscode.window.showInformationMessage('No scripts configured. Add them to automatedProcesses.scripts.');
		return undefined;
	}
	const picked = await vscode.window.showQuickPick(
		scripts.map((script) => ({ label: `$(${script.icon}) ${script.label}`, detail: script.steps.join(' → '), id: script.id })),
		{ title: 'Run Script' },
	);
	return picked?.id;
}

async function handleMessage(controller: Controller, executor: TaskExecutor, message: WebviewMessage): Promise<void> {
	switch (message.type) {
		case 'command':
			if (message.command === 'showOutput') {
				executor.showOutput();
			} else {
				await vscode.commands.executeCommand(`${COMMAND_PREFIX}.${message.command}`, message.database ?? message.server ?? message.section);
			}
			return;
		case 'migrateFrom':
			return controller.migrate({ source: message.database });
		case 'migrateTo':
			return controller.migrate({ target: message.database });
		case 'runScript':
			await controller.runScript(message.scriptId, message.step);
			return;
		case 'setInput':
			return controller.setInput(message.scriptId, message.name, message.value);
		case 'setShowAll':
			return controller.setShowAll(message.value);
		case 'setShowHidden':
			return controller.setShowHidden(message.value);
		case 'setOnBranchChange':
			return controller.setOnBranchChange(message.value);
		case 'setImportDataOnCreate':
			return controller.setImportDataOnCreate(message.value);
		case 'setServerRestartMode':
			return controller.setServerRestartMode(message.value);
		case 'setGitUpdateMode':
			return controller.setGitUpdateMode(message.value);
	}
}

function debounce(action: () => void, wait: number): () => void {
	let timer: NodeJS.Timeout | undefined;
	return () => {
		if (timer) {
			clearTimeout(timer);
		}
		timer = setTimeout(action, wait);
	};
}
