import * as assert from 'assert';
import { harness, MAIN_URL, testConfig } from './fakes';

const SESSION = { pid: 1, application: 'uvicorn', client: '172.18.0.1', user: 'app', state: 'idle' };

suite('Controller: refresh and view state', () => {
	test('start resolves the current database, applies env and lists databases', async () => {
		const h = harness({ databases: ['postgres', 'app', 'app_old', 'app_test_gw0'], config: testConfig({ database: { hidePatterns: ['postgres', '*_test_gw*'] }, migrations: { command: 'migrate' } }) });
		await h.controller.start();
		const state = h.controller.snapshot();
		assert.strictEqual(state.current?.name, 'app');
		assert.strictEqual(state.current?.isMain, true);
		assert.strictEqual(state.current?.linked, false);
		assert.strictEqual(state.dbStatus, 'ok');
		assert.deepStrictEqual(state.databases.map((db) => db.name), ['app', 'app_old']);
		assert.strictEqual(state.hiddenCount, 2);
		assert.strictEqual(h.envSink.last?.additions?.DATABASE_URL, MAIN_URL);
		assert.strictEqual(h.envSink.last?.additions?.OTHER, 'x');
		assert.strictEqual(h.envSink.last?.terminals, true);
		assert.ok(state.warnings.some((warning) => warning.action?.command === 'newDatabase'), 'feature branch on main is warned about');
		assert.strictEqual(h.engineSettings[0].user, 'app');
		assert.strictEqual(h.engineSettings[0].password, 'secret');
		assert.strictEqual(h.engineSettings[0].port, 5433);
	});

	test('showing hidden databases is remembered', async () => {
		const h = harness({ databases: ['postgres', 'app'] });
		await h.controller.start();
		await h.controller.setShowHidden(true);
		assert.deepStrictEqual(h.controller.snapshot().databases.map((db) => db.name), ['app', 'postgres']);
	});

	test('database errors become a warning with a start action', async () => {
		const h = harness({ config: testConfig({ database: { dockerComposeService: 'db' } }) });
		h.engine.failListing = new Error('service "db" is not running');
		await h.controller.start();
		const state = h.controller.snapshot();
		assert.strictEqual(state.dbStatus, 'error');
		assert.match(state.dbError ?? '', /not running/);
		assert.ok(state.warnings.some((warning) => warning.action?.command === 'startDatabase'));
		assert.strictEqual(state.canStartDatabase, true);
	});

	test('a container setting reaches the engine and enables Start Database', async () => {
		const h = harness({ config: testConfig({ database: { dockerContainer: 'carli-db-1' } }) });
		h.engine.failListing = new Error('container not running');
		await h.controller.start();
		assert.strictEqual(h.engineSettings[0].dockerContainer, 'carli-db-1');
		const state = h.controller.snapshot();
		assert.ok(state.warnings.some((warning) => warning.message.includes('"carli-db-1"') && warning.action?.command === 'startDatabase'));
		await h.controller.startDatabase();
		assert.strictEqual(h.executor.requests[0].command, 'docker start carli-db-1');
	});

	test('a missing psql explains how to use Docker instead', async () => {
		const h = harness();
		h.engine.failListing = new Error('"psql" was not found. Is it installed and on PATH?');
		await h.controller.start();
		assert.match(h.controller.snapshot().dbError ?? '', /set automatedProcesses\.database\.dockerContainer/);
		assert.strictEqual(h.controller.snapshot().canStartDatabase, false);
	});

	test('a missing env variable is a problem and clears the environment', async () => {
		const h = harness({ env: { main: {} } });
		await h.controller.start();
		const state = h.controller.snapshot();
		assert.ok(state.problems.some((problem) => problem.includes('DATABASE_URL is not set')));
		assert.strictEqual(state.current, undefined);
		assert.strictEqual(h.envSink.last?.additions, undefined);
	});

	test('no workspace folder', async () => {
		const h = harness({ root: undefined });
		await h.controller.start();
		assert.strictEqual(h.controller.snapshot().hasWorkspace, false);
	});

	test('script inputs use the saved choice when still valid', async () => {
		const h = harness({
			config: testConfig({ scripts: [{ id: 'ci', label: 'CI', icon: 'x', env: {}, inputs: { suite: { options: ['a', 'b'], default: 'a' } }, steps: [{ label: 's', run: 'echo ${input:suite}' }] }] }),
		});
		await h.controller.start();
		assert.strictEqual(h.controller.snapshot().scripts[0].inputs[0].value, 'a');
		await h.controller.setInput('ci', 'suite', 'b');
		assert.strictEqual(h.controller.snapshot().scripts[0].inputs[0].value, 'b');
		await h.controller.runScript('ci');
		assert.strictEqual(h.executor.requests[0].command, 'echo b');
	});
});

suite('Controller: New Database', () => {
	test('copies main, links the branch, switches, runs migrations', async () => {
		const h = harness();
		await h.controller.start();
		await h.controller.newDatabase();

		assert.deepStrictEqual(h.ui.messages('error'), []);
		assert.ok(h.engine.databases.has('app_login'));
		assert.ok(h.engine.calls.includes('template app -> app_login'));
		assert.ok(h.engine.calls.includes('settings app -> app_login'));
		assert.deepStrictEqual(h.store.linkOf('feature/login')?.database, 'app_login');
		assert.strictEqual(h.store.linkOf('feature/login')?.linkedAtCommit, 'c-login');
		assert.strictEqual(h.store.meta('app_login').lastCopiedFrom, 'app');

		const state = h.controller.snapshot();
		assert.strictEqual(state.current?.name, 'app_login');
		assert.strictEqual(state.current?.previous, 'app');
		assert.match(h.envSink.last?.additions?.DATABASE_URL ?? '', /\/app_login$/);

		assert.strictEqual(h.executor.requests.length, 1);
		assert.strictEqual(h.executor.requests[0].command, 'migrate up');
		assert.match(h.executor.requests[0].env.DATABASE_URL, /\/app_login$/);
		assert.ok(h.ui.messages('info').some((message) => message.includes('Created app_login')));
	});

	test('suggests a free name and validates input', async () => {
		const h = harness({ databases: ['postgres', 'app', 'app_login'] });
		await h.controller.start();
		h.ui.inputAnswer = () => undefined;
		await h.controller.newDatabase();
		const input = h.ui.log.find((entry) => entry.kind === 'input');
		assert.strictEqual(input?.detail, 'app_login_2');
		assert.match(h.ui.lastInputValidation?.('app_login') ?? '', /already exists/);
		assert.match(h.ui.lastInputValidation?.('Bad Name') ?? '', /lowercase/);
		assert.strictEqual(h.ui.lastInputValidation?.('app_new'), undefined);
		assert.ok(!h.engine.calls.some((call) => call.startsWith('template')));
	});

	test('asks before giving a main branch its own database', async () => {
		const h = harness();
		h.git.branch = 'main';
		await h.controller.start();
		h.ui.confirmAnswer = () => false;
		await h.controller.newDatabase();
		assert.ok(h.ui.messages('confirm')[0].includes('is a main branch'));
		assert.ok(!h.ui.log.some((entry) => entry.kind === 'input'));
	});

	test('fails clearly without a branch', async () => {
		const h = harness();
		h.git.branch = undefined;
		await h.controller.start();
		await h.controller.newDatabase();
		assert.match(h.ui.messages('error')[0], /No git branch/);
	});

	test('importDataOnCreate off creates an empty database, then migrates it', async () => {
		const h = harness({ config: testConfig({ database: { importDataOnCreate: false }, migrations: { command: 'migrate up' } }) });
		await h.controller.start();
		await h.controller.newDatabase();
		assert.ok(h.engine.calls.includes('createEmpty app_login'));
		assert.ok(!h.engine.calls.some((call) => call.startsWith('template') || call.startsWith('dump')));
		assert.match(h.ui.log.find((entry) => entry.kind === 'input')?.detail ?? '', /app_login/);
		assert.strictEqual(h.store.meta('app_login').lastCopiedFrom, undefined);
		assert.strictEqual(h.executor.requests.length, 1);
		assert.strictEqual(h.controller.snapshot().current?.name, 'app_login');
	});

	test('importDataOnCreate on (default) imports the main database', async () => {
		const h = harness();
		assert.strictEqual(h.config.database.importDataOnCreate, true);
		await h.controller.start();
		await h.controller.newDatabase();
		assert.ok(h.engine.calls.includes('template app -> app_login'));
	});

	test('skips migrations when no command is configured', async () => {
		const h = harness({ config: testConfig() });
		await h.controller.start();
		await h.controller.newDatabase();
		assert.strictEqual(h.executor.requests.length, 0);
		assert.strictEqual(h.controller.snapshot().current?.name, 'app_login');
	});
});

suite('Controller: copying with connections', () => {
	test('"Disconnect and Copy" terminates sessions then uses the template', async () => {
		const h = harness();
		h.engine.sessions.set('app', [SESSION]);
		await h.controller.start();
		h.ui.chooseAnswer = () => 'Disconnect and Copy';
		await h.controller.newDatabase();
		assert.ok(h.engine.calls.includes('terminate app'));
		assert.ok(h.engine.calls.includes('template app -> app_login'));
		const choose = h.ui.log.find((entry) => entry.kind === 'choose');
		assert.match(choose?.detail ?? '', /uvicorn/);
	});

	test('"Copy Without Disconnecting" uses dump and restore', async () => {
		const h = harness();
		h.engine.sessions.set('app', [SESSION]);
		await h.controller.start();
		h.ui.chooseAnswer = () => 'Copy Without Disconnecting';
		await h.controller.newDatabase();
		assert.ok(!h.engine.calls.includes('terminate app'));
		assert.ok(h.engine.calls.includes('createEmpty app_login'));
		assert.ok(h.engine.calls.includes('dump app -> app_login'));
		assert.ok(h.engine.calls.includes('settings app -> app_login'));
	});

	test('cancel stops before touching anything', async () => {
		const h = harness();
		h.engine.sessions.set('app', [SESSION]);
		await h.controller.start();
		h.ui.chooseAnswer = () => undefined;
		await h.controller.newDatabase();
		assert.ok(!h.engine.databases.has('app_login'));
		assert.strictEqual(h.store.linkOf('feature/login'), undefined);
	});

	test('a failed dump drops the half-made target and reports the error', async () => {
		const h = harness();
		h.engine.sessions.set('app', [SESSION]);
		h.engine.failDumpRestore = new Error('pg_restore failed');
		await h.controller.start();
		h.ui.chooseAnswer = () => 'Copy Without Disconnecting';
		await h.controller.newDatabase();
		assert.ok(!h.engine.databases.has('app_login'));
		assert.match(h.ui.messages('error')[0], /pg_restore failed/);
		assert.strictEqual(h.store.linkOf('feature/login'), undefined);
	});
});

suite('Controller: Export Data (migrate)', () => {
	test('defaults to main → current and replaces the target', async () => {
		const h = harness({ databases: ['postgres', 'app', 'app_login'] });
		await h.store.link('feature/login', 'app_login');
		await h.controller.start();
		await h.controller.migrate();
		assert.deepStrictEqual(h.engine.calls.filter((call) => /drop|template/.test(call)), ['drop app_login', 'template app -> app_login']);
		assert.strictEqual(h.store.meta('app_login').lastCopiedFrom, 'app');
		assert.strictEqual(h.executor.requests.length, 1, 'migrations after copy');
		assert.match(h.executor.requests[0].env.DATABASE_URL, /\/app_login$/);
		assert.ok(!h.ui.messages('confirm').some((message) => message.includes('main database')));
		assert.ok(!h.ui.lastPickItems.some((item) => item.value === 'postgres'));
	});

	test('copying into main needs a second, explicit confirmation', async () => {
		const h = harness({ databases: ['postgres', 'app', 'app_login'] });
		await h.controller.start();
		const answers = [true, false];
		h.ui.confirmAnswer = () => answers.shift() ?? false;
		await h.controller.migrate({ source: 'app_login', target: 'app' });
		assert.deepStrictEqual(h.ui.messages('confirm'), ['Replace app with a copy of app_login?', 'You are copying into the main database.']);
		assert.ok(!h.engine.calls.some((call) => call.startsWith('drop')));
	});

	test('copying into main copies everything once confirmed', async () => {
		const h = harness({ databases: ['postgres', 'app', 'app_login'], config: testConfig() });
		await h.controller.start();
		await h.controller.migrate({ source: 'app_login', target: 'app' });
		assert.ok(h.engine.calls.includes('drop app'));
		assert.ok(h.engine.calls.includes('template app_login -> app'));
	});

	test('rejects copying a database onto itself and honours afterCopy', async () => {
		const h = harness({ databases: ['postgres', 'app', 'x'], config: testConfig({ migrations: { command: 'm', afterCopy: false } }) });
		await h.controller.start();
		await h.controller.migrate({ source: 'x', target: 'x' });
		assert.match(h.ui.messages('error')[0], /two different databases/);
		await h.controller.migrate({ source: 'app', target: 'x' });
		assert.strictEqual(h.executor.requests.length, 0);
	});

	test('the source list excludes a preset target', async () => {
		const h = harness({ databases: ['postgres', 'app', 'a', 'b'] });
		await h.controller.start();
		h.ui.pickOneAnswer = () => undefined;
		await h.controller.migrate({ target: 'a' });
		assert.deepStrictEqual(h.ui.lastPickItems.map((item) => item.value), ['app', 'b']);
	});
});

suite('Controller: switching', () => {
	test('switchDatabase links the branch and switchBack returns', async () => {
		const h = harness({ databases: ['postgres', 'app', 'other'] });
		await h.controller.start();
		await h.controller.switchDatabase('other');
		assert.strictEqual(h.controller.snapshot().current?.name, 'other');
		assert.strictEqual(h.controller.snapshot().current?.previous, 'app');
		await h.controller.switchBack();
		assert.strictEqual(h.controller.snapshot().current?.name, 'app');
		assert.strictEqual(h.store.linkOf('feature/login'), undefined, 'switching to main unlinks');
		assert.strictEqual(h.controller.snapshot().current?.previous, 'other');
	});

	test('switching to a missing database fails', async () => {
		const h = harness();
		await h.controller.start();
		await h.controller.switchDatabase('ghost');
		assert.match(h.ui.messages('error')[0], /doesn't exist/);
	});

	test('switchBack without history says so', async () => {
		const h = harness();
		await h.controller.start();
		await h.controller.switchBack();
		assert.match(h.ui.messages('info')[0], /no previous database/);
	});
});

suite('Controller: branch changes', () => {
	async function onBranch(mode: 'off' | 'ask' | 'always', answer?: string) {
		const h = harness({ databases: ['postgres', 'app', 'app_x'], config: testConfig({ migrations: { command: 'migrate', onBranchChange: mode } }) });
		await h.store.link('x', 'app_x');
		h.git.branches.set('x', 'c-x');
		h.git.branch = 'main';
		await h.controller.start();
		h.ui.infoAnswer = () => answer;
		h.git.branch = 'x';
		await h.controller.onGitStateChanged();
		return h;
	}

	test('switches the current database with the branch', async () => {
		const h = await onBranch('off');
		assert.strictEqual(h.controller.snapshot().current?.name, 'app_x');
		assert.strictEqual(h.controller.snapshot().current?.previous, 'app');
		assert.match(h.envSink.last?.additions?.DATABASE_URL ?? '', /\/app_x$/);
		assert.strictEqual(h.executor.requests.length, 0);
	});

	test('"always" runs migrations on the branch database', async () => {
		const h = await onBranch('always');
		assert.strictEqual(h.executor.requests.length, 1);
		assert.match(h.executor.requests[0].env.DATABASE_URL, /\/app_x$/);
	});

	test('"ask" runs only when accepted', async () => {
		assert.strictEqual((await onBranch('ask')).executor.requests.length, 0);
		assert.strictEqual((await onBranch('ask', 'Run Migrations')).executor.requests.length, 1);
	});

	test('a branch without a database never migrates main and offers New Database', async () => {
		const h = harness({ config: testConfig({ migrations: { command: 'migrate', onBranchChange: 'always' } }) });
		h.git.branch = 'main';
		await h.controller.start();
		h.git.branch = 'feature/login';
		await h.controller.onGitStateChanged();
		assert.strictEqual(h.executor.requests.length, 0);
		const info = h.ui.log.find((entry) => entry.kind === 'info');
		assert.match(info?.message ?? '', /has no database of its own/);
		assert.deepStrictEqual(info?.actions, ['New Database']);
	});

	test('the first branch seen (repository opening) does not prompt', async () => {
		const h = harness({ config: testConfig({ migrations: { command: 'migrate', onBranchChange: 'always' } }) });
		h.git.branch = undefined;
		await h.controller.start();
		h.git.branch = 'main';
		await h.controller.onGitStateChanged();
		assert.strictEqual(h.executor.requests.length, 0);
		assert.strictEqual(h.ui.log.length, 0);
	});

	test('git changes without a branch switch do nothing', async () => {
		const h = await onBranch('always');
		const calls = h.engine.calls.length;
		await h.controller.onGitStateChanged();
		assert.strictEqual(h.engine.calls.length, calls);
	});
});

suite('Controller: Run Migrations', () => {
	test('warns before migrating main from a feature branch', async () => {
		const h = harness();
		await h.controller.start();
		h.ui.confirmAnswer = () => false;
		await h.controller.runMigrations();
		assert.match(h.ui.messages('confirm')[0], /main database from "feature\/login"/);
		assert.strictEqual(h.executor.requests.length, 0);
	});

	test('runs on main from a main branch without asking', async () => {
		const h = harness();
		h.git.branch = 'main';
		await h.controller.start();
		await h.controller.runMigrations();
		assert.strictEqual(h.ui.messages('confirm').length, 0);
		assert.strictEqual(h.executor.requests.length, 1);
		assert.match(h.ui.messages('info')[0], /Migrations applied to app/);
	});

	test('reports a failed migration', async () => {
		const h = harness();
		h.git.branch = 'main';
		h.executor.exitCode = () => 1;
		await h.controller.start();
		await h.controller.runMigrations();
		assert.match(h.ui.messages('error')[0], /Migrations on app failed/);
	});

	test('explains a missing command', async () => {
		const h = harness({ config: testConfig() });
		await h.controller.start();
		await h.controller.runMigrations();
		assert.match(h.ui.messages('error')[0], /migrations\.command/);
	});
});

suite('Controller: removing and cleaning up', () => {
	test('removeDatabase drops the database and its test databases', async () => {
		const h = harness({ databases: ['postgres', 'app', 'app_x', 'app_x_test', 'app_x_test_gw0', 'app_xy_test'] });
		await h.store.link('feature/login', 'app_x');
		await h.controller.start();
		await h.controller.removeDatabase('app_x');
		assert.deepStrictEqual(h.engine.calls.filter((call) => call.startsWith('drop')), ['drop app_x', 'drop app_x_test', 'drop app_x_test_gw0']);
		assert.ok(h.engine.databases.has('app_xy_test'));
		assert.strictEqual(h.store.linkOf('feature/login'), undefined);
		assert.strictEqual(h.controller.snapshot().current?.name, 'app');
	});

	test('main and maintenance databases cannot be removed', async () => {
		const h = harness();
		await h.controller.start();
		await h.controller.removeDatabase('app');
		await h.controller.removeDatabase('postgres');
		assert.strictEqual(h.ui.messages('error').length, 2);
		assert.ok(!h.engine.calls.some((call) => call.startsWith('drop')));
	});

	test('cleanUpDatabases pre-selects hidden ones and protects main and current', async () => {
		const h = harness({
			databases: ['postgres', 'app', 'app_x', 'app_x_test', 'old_test', 'keep_me'],
			config: testConfig({ database: { hidePatterns: ['postgres', '*_test'] }, testDatabase: { urlVariables: ['DATABASE_URL'] } }),
		});
		await h.store.link('feature/login', 'app_x');
		await h.controller.start();
		await h.controller.cleanUpDatabases();
		const offered = h.ui.lastPickItems.map((item) => item.value);
		assert.deepStrictEqual(offered, ['keep_me', 'old_test']);
		assert.deepStrictEqual(h.engine.calls.filter((call) => call.startsWith('drop')), ['drop old_test']);
	});
});

suite('Controller: merged branches', () => {
	async function setupMerged(mode: 'delete' | 'keep') {
		const h = harness({
			databases: ['postgres', 'app', 'app_done', 'app_done_test', 'app_fresh'],
			config: testConfig({ database: { onBranchMerged: mode } }),
		});
		await h.store.link('done', 'app_done', 'c1');
		await h.store.link('fresh', 'app_fresh', 'c-fresh');
		h.git.branches.set('done', 'c2');
		h.git.branches.set('fresh', 'c-fresh');
		h.git.merged = new Set(['done', 'fresh', 'main']);
		await h.controller.start();
		return h;
	}

	test('drops databases of merged branches by default', async () => {
		const h = await setupMerged('delete');
		assert.deepStrictEqual(h.engine.calls.filter((call) => call.startsWith('drop')), ['drop app_done', 'drop app_done_test']);
		assert.strictEqual(h.store.linkOf('done'), undefined);
		assert.ok(h.store.linkOf('fresh'), 'a branch that never moved is not treated as merged');
		assert.match(h.ui.messages('info')[0], /Dropped app_done, app_done_test: done \(merged\)/);
	});

	test('"keep" only unlinks', async () => {
		const h = await setupMerged('keep');
		assert.ok(!h.engine.calls.some((call) => call.startsWith('drop')));
		assert.strictEqual(h.store.linkOf('done'), undefined);
		assert.ok(h.engine.databases.has('app_done'));
	});

	test('deleted branches count as finished, the current branch never does', async () => {
		const h = harness({ databases: ['postgres', 'app', 'app_gone', 'app_login'] });
		await h.store.link('gone', 'app_gone', 'c');
		await h.store.link('feature/login', 'app_login', 'c-login');
		h.git.branches.delete('feature/login');
		await h.controller.start();
		assert.ok(!h.engine.databases.has('app_gone'));
		assert.ok(h.engine.databases.has('app_login'));
	});

	test('does nothing when the database is unreachable', async () => {
		const h = harness({ databases: ['postgres', 'app', 'app_gone'] });
		await h.store.link('gone', 'app_gone', 'c');
		h.engine.failListing = new Error('down');
		await h.controller.start();
		assert.ok(h.store.linkOf('gone'), 'link kept for the next try');
	});
});

suite('Controller: server restart on database change', () => {
	const serverConfig = (overrides: { onDatabaseChange?: 'restart' | 'ask' | 'off'; onBranchChange?: 'off' | 'ask' | 'always' } = {}) => testConfig({
		migrations: { command: 'migrate', onBranchChange: overrides.onBranchChange ?? 'off' },
		server: { command: 'serve', onDatabaseChange: overrides.onDatabaseChange ?? 'restart' },
	});

	test('switching the database restarts a running server and debug sessions on the new one', async () => {
		const h = harness({ databases: ['postgres', 'app', 'other'], config: serverConfig() });
		await h.controller.start();
		await h.controller.startServer();
		h.server.sessions = ['Backend: FastAPI'];
		await h.controller.switchDatabase('other');
		assert.deepStrictEqual(h.server.events, ['start serve @ app', 'restart serve @ other', 'debug Backend: FastAPI']);
		assert.ok(h.ui.messages('info').some((message) => message === 'Restarted server, Backend: FastAPI on other.'));
		assert.strictEqual(h.server.lastEnv?.OTHER, 'x', 'the server gets the env file values too');
	});

	test('nothing is started when nothing is running', async () => {
		const h = harness({ databases: ['postgres', 'app', 'other'], config: serverConfig() });
		await h.controller.start();
		await h.controller.switchDatabase('other');
		assert.deepStrictEqual(h.server.events, []);
	});

	test('"off" leaves the server alone and "ask" restarts only when accepted', async () => {
		const off = harness({ databases: ['postgres', 'app', 'other'], config: serverConfig({ onDatabaseChange: 'off' }) });
		await off.controller.start();
		await off.controller.startServer();
		await off.controller.switchDatabase('other');
		assert.deepStrictEqual(off.server.events, ['start serve @ app']);

		const ask = harness({ databases: ['postgres', 'app', 'other'], config: serverConfig({ onDatabaseChange: 'ask' }) });
		await ask.controller.start();
		await ask.controller.startServer();
		ask.ui.infoAnswer = (message) => (message.startsWith('Now using other') ? 'Restart' : undefined);
		await ask.controller.switchDatabase('other');
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepStrictEqual(ask.server.events, ['start serve @ app', 'restart serve @ other']);
	});

	test('a branch switch restarts once, after automatic migrations', async () => {
		const h = harness({ databases: ['postgres', 'app', 'app_x'], config: serverConfig({ onBranchChange: 'always' }) });
		await h.store.link('x', 'app_x');
		h.git.branches.set('x', 'c-x');
		h.git.branch = 'main';
		await h.controller.start();
		await h.controller.startServer();
		const order: string[] = [];
		h.executor.exitCode = (request) => {
			order.push(`migrate @ ${request.env.DATABASE_URL.split('/').pop()}`);
			return 0;
		};
		const startServer = h.server.startServer.bind(h.server);
		h.server.startServer = async (command, env) => {
			order.push(`server @ ${env.DATABASE_URL.split('/').pop()}`);
			return startServer(command, env);
		};
		h.git.branch = 'x';
		await h.controller.onGitStateChanged();
		assert.deepStrictEqual(order, ['migrate @ app_x', 'server @ app_x']);
	});

	test('a branch switch without automatic migrations restarts right away', async () => {
		const h = harness({ databases: ['postgres', 'app', 'app_x'], config: serverConfig({ onBranchChange: 'ask' }) });
		await h.store.link('x', 'app_x');
		h.git.branches.set('x', 'c-x');
		h.git.branch = 'main';
		await h.controller.start();
		await h.controller.startServer();
		h.git.branch = 'x';
		await h.controller.onGitStateChanged();
		assert.deepStrictEqual(h.server.events, ['start serve @ app', 'restart serve @ app_x']);
		assert.strictEqual(h.executor.requests.length, 0, 'migrations still wait for the answer');
	});

	test('New Database restarts after its migrations', async () => {
		const h = harness({ config: serverConfig() });
		await h.controller.start();
		await h.controller.startServer();
		await h.controller.newDatabase();
		assert.deepStrictEqual(h.server.events, ['start serve @ app', 'restart serve @ app_login']);
		assert.strictEqual(h.executor.requests.length, 1);
	});

	test('the first refresh never restarts', async () => {
		const h = harness({ databases: ['postgres', 'app', 'app_login'], config: serverConfig() });
		await h.store.setCurrent('app');
		await h.store.link('feature/login', 'app_login');
		h.server.running = true;
		await h.controller.start();
		assert.deepStrictEqual(h.server.events, []);
	});

	test('manual start, stop and restart', async () => {
		const h = harness({ config: serverConfig() });
		await h.controller.start();
		await h.controller.restartServer();
		await h.controller.stopServer();
		assert.deepStrictEqual(h.server.events, ['start serve @ app', 'stop']);
		assert.strictEqual(h.controller.snapshot().server.running, false);
		await h.controller.restartServer();
		assert.deepStrictEqual(h.server.events.slice(-1), ['start serve @ app']);

		const none = harness();
		await none.controller.start();
		await none.controller.startServer();
		assert.match(none.ui.messages('error')[0], /server\.command/);
		await none.controller.restartServer();
		assert.match(none.ui.messages('info')[0], /Nothing to restart/);
	});
});

suite('Controller: scripts and settings', () => {
	test('runScript passes the full environment and placeholders', async () => {
		const h = harness({
			config: testConfig({
				env: { GLOBAL: '${db.name}' },
				scripts: [{ id: 'ci', label: 'CI', icon: 'x', env: { SMOKE: '${db.url}' }, inputs: {}, steps: [{ label: 'a', run: 'echo ${branch}' }] }],
			}),
		});
		await h.controller.start();
		const result = await h.controller.runScript('ci');
		assert.strictEqual(result?.status, 'passed');
		const request = h.executor.requests[0];
		assert.strictEqual(request.command, 'echo feature/login');
		assert.strictEqual(request.env.SMOKE, MAIN_URL);
		assert.strictEqual(request.env.GLOBAL, 'app');
		assert.strictEqual(request.env.OTHER, 'x');
		assert.strictEqual(request.env.PATH, '/bin');
		assert.strictEqual(request.cwd, '/repo');
	});

	test('unknown scripts are reported', async () => {
		const h = harness();
		await h.controller.start();
		assert.strictEqual(await h.controller.runScript('nope'), undefined);
		assert.match(h.ui.messages('error')[0], /No script with id "nope"/);
	});

	test('startDatabase runs docker compose and refreshes', async () => {
		const h = harness({ config: testConfig({ database: { dockerComposeService: 'db' } }) });
		await h.controller.start();
		await h.controller.startDatabase();
		assert.strictEqual(h.executor.requests[0].command, 'docker compose up --detach --wait db');
	});

	test('the branch-change mode and settings are delegated', async () => {
		const h = harness();
		await h.controller.setOnBranchChange('always');
		h.controller.openSettings();
		assert.deepStrictEqual(h.settings.updates, [['migrations.onBranchChange', 'always']]);
		assert.strictEqual(h.settings.opened, 1);
	});

	test('only one database action runs at a time', async () => {
		const h = harness({ databases: ['postgres', 'app', 'other'] });
		await h.controller.start();
		let release: () => void = () => undefined;
		h.ui.input = async () => {
			await new Promise<void>((resolve) => (release = resolve));
			return undefined;
		};
		const first = h.controller.newDatabase();
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(h.controller.snapshot().busy, 'Creating database');
		await h.controller.switchDatabase('other');
		assert.match(h.ui.messages('info')[0], /Please wait/);
		release();
		await first;
		assert.strictEqual(h.controller.snapshot().busy, undefined);
	});
});
