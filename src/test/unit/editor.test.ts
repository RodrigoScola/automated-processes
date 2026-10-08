import * as assert from 'assert';
import { DEFAULT_CONFIG, mergeLaunchServers, readConfig, ScriptDefinition, ServerDefinition } from '../../core/config';
import { databaseValues, deleteScript, maskUrl, moveScript, panelState, serverValues, upsertScript, upsertServer, urlProblem } from '../../core/editor';
import { PanelDatabaseForm, PanelState } from '../../shared/panelProtocol';
import { databaseDraft, databaseForm, draftToScript, initialScope, migrationsDraft, PanelUi, renderPanel, scriptDraft } from '../../webview/panelRender';

function uiFor(state: PanelState, tab: PanelUi['tab']): PanelUi {
	return { tab, scope: initialScope(state), db: databaseDraft(state), dbDirty: false, migrations: migrationsDraft(state), migrationsDirty: false, iconSearch: '' };
}

const setup: ScriptDefinition = {
	id: 'setup', label: 'Setup', icon: 'tools', env: { A: '1' },
	inputs: { suite: { options: ['backend', 'all'], default: 'all' } },
	steps: [{ label: 'Install', run: 'npm ci' }, { label: 'Env', copyFile: { from: '.env.example', to: '.env', ifMissing: true } }],
};
const backend: ServerDefinition = { id: 'backend', label: 'Backend', command: 'npm run dev', debugConfiguration: 'Backend', restartOnDatabaseChange: true };

suite('launch.json merge', () => {
	test('launch configurations come first; a configured server naming one takes its place', () => {
		const merged = mergeLaunchServers([{ ...backend }, { id: 'web', label: 'Web', command: 'vite', debugConfiguration: '', restartOnDatabaseChange: false }],
			[{ name: 'Tests' }, { name: 'Backend' }]);
		assert.deepStrictEqual(merged.map((server) => [server.id, server.source, server.command]), [
			['Tests', 'launch', ''],
			['backend', 'both', 'npm run dev'],
			['web', 'config', 'vite'],
		]);
		assert.strictEqual(merged[0].debugConfiguration, 'Tests');
	});

	test('reads the new connection settings', () => {
		const { config } = readConfig((key) => ({ 'database.engine': 'sqlite', 'database.url': 'sqlite:///a.db', 'database.sqliteFolder': 'prisma', 'server.includeLaunchConfigurations': false } as Record<string, unknown>)[key]);
		assert.strictEqual(config.database.engine, 'sqlite');
		assert.strictEqual(config.database.url, 'sqlite:///a.db');
		assert.strictEqual(config.database.sqliteFolder, 'prisma');
		assert.strictEqual(config.server.includeLaunchConfigurations, false);
		assert.strictEqual(readConfig((key) => (key === 'database.engine' ? 'oracle' : undefined)).config.database.engine, 'auto');
	});
});

suite('editor: scripts', () => {
	test('adds with an id from the name, edits in place, deletes and moves', () => {
		const added = upsertScript([setup], { ...setup, id: '', label: 'Check CI', steps: [{ label: '', run: 'npm test' }] });
		assert.ok(Array.isArray(added));
		assert.deepStrictEqual(added.map((script) => script.id), ['setup', 'check-ci']);
		assert.strictEqual(added[1].steps[0].label, 'npm test', 'an unnamed step is named after its command');

		const edited = upsertScript(added, { ...added[0], label: 'Set up' }, 'setup') as ScriptDefinition[];
		assert.deepStrictEqual(edited.map((script) => [script.id, script.label]), [['setup', 'Set up'], ['check-ci', 'Check CI']]);
		assert.deepStrictEqual(moveScript(edited, 'check-ci', -1).map((script) => script.id), ['check-ci', 'setup']);
		assert.deepStrictEqual(moveScript(edited, 'setup', -1).map((script) => script.id), ['setup', 'check-ci']);
		assert.deepStrictEqual(deleteScript(edited, 'setup').map((script) => script.id), ['check-ci']);
	});

	test('two scripts with the same name get different ids', () => {
		const first = upsertScript([], { ...setup, id: '' }) as ScriptDefinition[];
		const second = upsertScript(first, { ...setup, id: '' }) as ScriptDefinition[];
		assert.deepStrictEqual(second.map((script) => script.id), ['setup', 'setup-2']);
	});

	test('rejects a script without a name or a usable step', () => {
		assert.match(upsertScript([], { ...setup, label: ' ' }) as string, /name/);
		assert.match(upsertScript([], { ...setup, steps: [{ label: 'x', run: '  ' }, { label: 'y', copyFile: { from: 'a', to: '', ifMissing: true } }] }) as string, /at least one step/);
	});

	test('saved scripts read back the same through the settings reader', () => {
		const saved = upsertScript([], setup, 'setup') as ScriptDefinition[];
		assert.deepStrictEqual(readConfig((key) => (key === 'scripts' ? saved : undefined)).config.scripts, saved);
	});
});

suite('editor: servers', () => {
	test('adds, edits and validates servers', () => {
		const added = upsertServer([backend], { label: 'Worker', command: 'npm run worker', debugConfiguration: '', restartOnDatabaseChange: true, cwd: './worker/', runOnStartup: false }) as ServerDefinition[];
		assert.deepStrictEqual(added.map((server) => server.id), ['backend', 'worker']);
		assert.strictEqual(added[1].cwd, 'worker', 'folders are cleaned up');
		const edited = upsertServer(added, { label: 'API', command: 'serve', debugConfiguration: 'Backend', restartOnDatabaseChange: false, cwd: '', runOnStartup: false }, 'backend') as ServerDefinition[];
		assert.deepStrictEqual(edited[0], { id: 'backend', label: 'API', command: 'serve', debugConfiguration: 'Backend', restartOnDatabaseChange: false });
		assert.match(upsertServer([], { label: 'X', command: '', debugConfiguration: '', restartOnDatabaseChange: true, cwd: '', runOnStartup: false }) as string, /run command/);
	});

	test('giving a launch.json-only server a command adds a configured one that merges with it', () => {
		const saved = upsertServer([], { label: 'Tests', command: 'npm test', debugConfiguration: 'Tests', restartOnDatabaseChange: true, cwd: '', runOnStartup: false }) as ServerDefinition[];
		const merged = mergeLaunchServers(saved, [{ name: 'Tests' }]);
		assert.deepStrictEqual(merged.map((server) => [server.label, server.source, server.command]), [['Tests', 'both', 'npm test']]);
	});

	test('stored servers clear the legacy single-server keys and drop the merge marker', () => {
		const values = serverValues([{ ...backend, source: 'both' }]);
		assert.deepStrictEqual(values, { servers: [backend], 'server.command': '', 'server.debugConfiguration': '' });
		const read = readConfig((key) => (key in values ? (values as Record<string, unknown>)[key] : key === 'server.command' ? 'old' : undefined));
		assert.deepStrictEqual(read.config.servers, [backend]);
	});
});

suite('editor: database', () => {
	const form: PanelDatabaseForm = { engine: 'auto', source: 'envFile', envFile: '.env', urlVariable: 'DATABASE_URL', runsIn: 'container', dockerName: 'my-db-1', sqliteFolder: '', mainBranches: ['main', 'staging'] };
	const current = { ...DEFAULT_CONFIG, database: { ...DEFAULT_CONFIG.database, urlVariables: ['DATABASE_URL', 'DATABASE_ADMIN_URL'] } };

	test('turns the form into setting values, keeping extra URL variables', () => {
		const result = databaseValues(form, current);
		assert.ok('values' in result);
		assert.deepStrictEqual(result.values, {
			'database.engine': 'auto',
			envFile: '.env',
			'database.urlVariables': ['DATABASE_URL', 'DATABASE_ADMIN_URL'],
			'database.dockerContainer': 'my-db-1',
			'database.dockerComposeService': '',
			'database.sqliteFolder': '',
			'database.mainBranches': ['main', 'staging'],
		});
	});

	test('rejects unsafe Docker names, bad variables and no main branch', () => {
		assert.match((databaseValues({ ...form, dockerName: 'db; rm -rf /' }, current) as { problem: string }).problem, /container name/);
		assert.match((databaseValues({ ...form, urlVariable: 'MY-URL' }, current) as { problem: string }).problem, /valid variable/);
		assert.match((databaseValues({ ...form, mainBranches: [] }, current) as { problem: string }).problem, /main branch/);
	});

	test('checks entered URLs and hides passwords', () => {
		assert.strictEqual(urlProblem('postgresql://u:p@localhost:5432/app', 'auto'), undefined);
		assert.match(urlProblem('postgresql://u:p@localhost:5432', 'auto') ?? '', /database name/);
		assert.match(urlProblem('postgres://h/app', 'sqlite') ?? '', /isn't a SQLite URL/);
		assert.strictEqual(urlProblem('sqlite:///data/app.db', 'sqlite'), undefined);
		assert.strictEqual(maskUrl('postgresql://app:s3cret@localhost:5432/app'), 'postgresql://app:•••@localhost:5432/app');
		assert.strictEqual(maskUrl('postgresql://localhost/app'), 'postgresql://localhost/app');
		assert.strictEqual(maskUrl('sqlite:///a.db'), 'sqlite:///a.db');
	});
});

suite('Configure panel', () => {
	function state(): PanelState {
		return panelState({
			config: { ...DEFAULT_CONFIG, scripts: [setup], servers: [backend] },
			servers: mergeLaunchServers([backend], [{ name: 'Tests' }, { name: 'Backend' }]),
			launchConfigurations: ['Tests', 'Backend'],
			stored: { local: { scripts: [setup] }, global: { 'database.engine': 'postgres', servers: [] } },
			mainUrl: 'postgresql://app:pw@localhost:5432/app',
			urlScope: 'global',
			problems: [],
		});
	}

	test('panel state says what is stored and never sends the password', () => {
		const panel = state();
		assert.deepStrictEqual(panel.stored, { database: 'global', servers: 'global', scripts: 'local' });
		assert.deepStrictEqual(panel.launchConfigurations, [{ name: 'Tests', added: false }, { name: 'Backend', added: true }]);
		assert.strictEqual(panel.database.source, 'url');
		assert.strictEqual(panel.database.detectedEngine, 'postgres');
		assert.ok(!JSON.stringify(panel).includes(':pw@'));
	});

	test('a script survives the form round trip', () => {
		// The default option moves to the front; a step named after its command loses the copy of the name.
		assert.deepStrictEqual(draftToScript(scriptDraft(setup), 'setup'), { ...setup, inputs: { suite: { options: ['all', 'backend'], default: 'all' } } });
		assert.strictEqual(scriptDraft({ ...setup, steps: [{ label: 'npm ci', run: 'npm ci' }] }).steps[0].label, '');
		const draft = scriptDraft(setup);
		assert.strictEqual(draft.inputs, 'suite = all, backend', 'the default comes first');
	});

	test('the database form round trip', () => {
		const form = databaseForm(databaseDraft(state()));
		assert.strictEqual(form.url, undefined, 'an empty URL field keeps the saved one');
		assert.deepStrictEqual(form.mainBranches, ['main']);
	});

	test('renders each tab', () => {
		const panel = state();
		const ui = uiFor(panel, 'database');
		const database = renderPanel(panel, ui);
		assert.match(database, /type="password" data-bind="db.url"/);
		assert.match(database, /Saved: <code>postgresql:\/\/app:•••@localhost:5432\/app<\/code>/);
		assert.match(database, /data-bind="db.runsIn"/);

		const servers = renderPanel(panel, { ...ui, tab: 'servers' });
		assert.match(servers, /Tests <span class="pill">launch.json<\/span>/);
		assert.match(servers, /data-action="delete-server" data-id="backend"/);
		assert.ok(!/data-action="delete-server" data-id="Tests"/.test(servers), 'launch.json servers are edited there');

		const scripts = renderPanel(panel, { ...ui, tab: 'scripts', editing: { kind: 'script', originalId: 'setup', draft: scriptDraft(setup) } });
		assert.match(scripts, /data-bind="editing.draft.steps.1.from" value=".env.example"/);
		assert.match(scripts, /data-action="save-script"/);
	});

	test('escapes everything users typed', () => {
		const panel = state();
		panel.scripts = [{ ...setup, label: '<img src=x onerror=alert(1)>' }];
		const html = renderPanel(panel, uiFor(panel, 'scripts'));
		assert.ok(!html.includes('<img'));
	});
});
