import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Controller } from '../../core/controller';

const EXTENSION_ID = 'local.automated-processes';

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
		for (const name of ['newDatabase', 'migrate', 'switchDatabase', 'switchBack', 'removeDatabase', 'cleanUpDatabases', 'runMigrations', 'runScript', 'startDatabase', 'refresh', 'openSettings']) {
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

	test('the sidebar view opens', async () => {
		await vscode.commands.executeCommand('automatedProcesses.sidebar.focus');
	});
});
