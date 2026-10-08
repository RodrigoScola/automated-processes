import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Controller } from '../../core/controller';

const EXTENSION_ID = 'rodrigoscola.automated-processes';

suite('Extension (in VS Code)', function () {
	this.timeout(60_000);
	let controller: Controller;
	const workspace = () => vscode.workspace.workspaceFolders![0].uri.fsPath;

	suiteSetup(async () => {
		const extension = vscode.extensions.getExtension<Controller>(EXTENSION_ID);
		assert.ok(extension, 'extension is installed');
		controller = await extension.activate();
	});

	test('registers its commands', async () => {
		const commands = await vscode.commands.getCommands(true);
		for (const name of ['newDatabase', 'migrate', 'switchDatabase', 'switchBack', 'removeDatabase', 'cleanUpDatabases', 'runMigrations', 'runScript', 'startDatabase', 'connectDatabase', 'refresh', 'openSettings', 'configure']) {
			assert.ok(commands.includes(`automated-processes.${name}`), name);
		}
	});

	test('reads settings and the env file of the workspace', async () => {
		await controller.refresh();
		const state = controller.snapshot();
		assert.strictEqual(state.hasWorkspace, true);
		assert.deepStrictEqual(state.problems, []);
		assert.strictEqual(state.current?.name, 'fixture_app');
		assert.strictEqual(state.current?.isMain, true);
		assert.deepStrictEqual(state.scripts.map((script) => script.id), ['print-env']);
		// No psql on the test machine / nothing on port 1: the list fails gracefully.
		assert.strictEqual(state.dbStatus, 'error');
		assert.ok(state.dbError);
	});

	test('runs a script as a VS Code task with the database environment', async () => {
		const output = path.join(workspace(), 'env-output.json');
		fs.rmSync(output, { force: true });
		const result = await controller.runScript('print-env');
		assert.strictEqual(result?.status, 'passed', JSON.stringify(result));
		const env = JSON.parse(fs.readFileSync(output, 'utf8'));
		assert.deepStrictEqual(env, {
			DATABASE_URL: 'postgres://fixture:fixture-pw@127.0.0.1:1/fixture_app',
			FIXTURE_ONLY: 'from-env-file',
			SCRIPT_VAR: 'fixture_app',
		});
		fs.rmSync(output, { force: true });
	});

	const serverRunning = () => controller.snapshot().servers.find((server) => server.id === 'server')?.status === 'running';

	test('starts, restarts and stops the server as a task with the database environment', async () => {
		const output = path.join(workspace(), 'server-output.json');
		const readOutput = async (): Promise<{ DATABASE_URL: string; pid: number }> => {
			for (let attempt = 0; attempt < 100; attempt++) {
				if (fs.existsSync(output)) {
					return JSON.parse(fs.readFileSync(output, 'utf8'));
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			throw new Error('server did not start');
		};
		fs.rmSync(output, { force: true });

		await controller.startServer('server');
		const first = await readOutput();
		assert.strictEqual(first.DATABASE_URL, 'postgres://fixture:fixture-pw@127.0.0.1:1/fixture_app');
		assert.strictEqual(serverRunning(), true);

		fs.rmSync(output, { force: true });
		await controller.restartServer('server');
		const second = await readOutput();
		assert.notStrictEqual(second.pid, first.pid, 'a new process');
		assert.strictEqual(serverRunning(), true);

		await controller.stopServer('server');
		for (let attempt = 0; attempt < 50 && serverRunning(); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.strictEqual(serverRunning(), false);
		fs.rmSync(output, { force: true });
	});

	test('the sidebar view opens', async () => {
		await vscode.commands.executeCommand('automatedProcesses.sidebar.focus');
	});

	test('the Configure panel opens as an editor tab', async () => {
		await vscode.commands.executeCommand('automated-processes.configure', 'scripts');
		// The tab shows up a moment after the panel is created.
		const labels = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label));
		for (let tries = 0; tries < 40 && !labels().includes('Automated Processes: Configure'); tries++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
		assert.ok(tabs.some((tab) => tab.label === 'Automated Processes: Configure'), tabs.map((tab) => tab.label).join(', '));
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	});
});
