import * as assert from 'assert';
import * as path from 'path';
import { DEFAULT_DOWN_REVISION_PATTERN, DEFAULT_REVISION_PATTERN } from '../../core/migrationSync';
import { harness, MAIN_URL, testConfig } from './fakes';
import { migration } from './migrationSync.test';

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

	test('the list shows main first, then the current database, then the rest by name', async () => {
		const h = harness({ databases: ['postgres', 'app', 'app_a', 'app_b', 'app_login', 'app_z'] });
		await h.store.link('feature/login', 'app_login');
		await h.controller.start();
		assert.deepStrictEqual(h.controller.snapshot().databases.map((db) => db.name), ['app', 'app_login', 'app_a', 'app_b', 'app_z']);
	});

	test('showing hidden databases is remembered', async () => {
		const h = harness({ databases: ['postgres', 'app'] });
		await h.controller.start();
		await h.controller.setShowHidden(true);
		assert.deepStrictEqual(h.controller.snapshot().databases.map((db) => db.name), ['app', 'postgres']);
	});

	test('a stopped container is started on startup, with a retry warning while it stays down', async () => {
		const h = harness({ config: testConfig({ database: { dockerComposeService: 'db' } }) });
		h.engine.failListing = new Error('service "db" is not running');
		h.executor.exitCode = () => 1;
		await h.controller.start();
		assert.strictEqual(h.executor.requests[0].command, 'docker compose up --detach --wait db');
		const state = h.controller.snapshot();
		assert.strictEqual(state.dbStatus, 'error');
		assert.match(state.dbError ?? '', /not running/);
		assert.ok(state.warnings.some((warning) => warning.message.includes('"db"') && warning.action?.command === 'connectDatabase'));
		assert.strictEqual(state.canStartDatabase, true);
		assert.match(h.ui.messages('error')[0], /Starting "db" failed/);
	});

	test('a container started on startup clears the warning', async () => {
		const h = harness({ config: testConfig({ database: { dockerContainer: 'carli-db-1' } }) });
		h.engine.failListing = new Error('docker failed: Error response from daemon: container carli-db-1 is not running');
		h.executor.exitCode = () => {
			h.engine.failListing = undefined;
			return 0;
		};
		await h.controller.start();
		assert.strictEqual(h.engineSettings[0].dockerContainer, 'carli-db-1');
		assert.strictEqual(h.executor.requests[0].command, 'docker start carli-db-1');
		assert.strictEqual(h.controller.snapshot().dbStatus, 'ok');
		assert.deepStrictEqual(h.controller.snapshot().warnings.filter((warning) => warning.action?.command === 'connectDatabase'), []);
	});

	test('when Docker itself is down, nothing is started and Retry checks again', async () => {
		const h = harness({ config: testConfig({ database: { dockerContainer: 'carli-db-1' } }) });
		h.engine.failListing = new Error('docker failed (exit code 1): error during connect: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.');
		await h.controller.start();
		assert.strictEqual(h.executor.requests.length, 0);
		const warning = h.controller.snapshot().warnings.find((item) => item.action?.command === 'connectDatabase');
		assert.match(warning?.message ?? '', /Docker isn't running/);

		// Docker is up now, but the container is still stopped: Retry starts it.
		h.engine.failListing = new Error('container carli-db-1 is not running');
		h.executor.exitCode = () => {
			h.engine.failListing = undefined;
			return 0;
		};
		await h.controller.connectDatabase();
		assert.strictEqual(h.executor.requests[0].command, 'docker start carli-db-1');
		assert.strictEqual(h.controller.snapshot().dbStatus, 'ok');
	});

	test('other database errors with Docker keep the Start Database action', async () => {
		const h = harness({ config: testConfig({ database: { dockerContainer: 'carli-db-1' } }) });
		h.engine.failListing = new Error('password authentication failed');
		await h.controller.start();
		assert.strictEqual(h.executor.requests.length, 0);
		assert.ok(h.controller.snapshot().warnings.some((warning) => warning.message.includes('"carli-db-1"') && warning.action?.command === 'startDatabase'));
	});

	test('with autoStartContainer off, a stopped container is never started by itself', async () => {
		const h = harness({ config: testConfig({ database: { dockerContainer: 'carli-db-1', autoStartContainer: false } }) });
		h.engine.failListing = new Error('container carli-db-1 is not running');
		await h.controller.start();
		await h.controller.connectDatabase();
		assert.strictEqual(h.executor.requests.length, 0);
		const warning = h.controller.snapshot().warnings.find((item) => item.message.includes('"carli-db-1"'));
		assert.strictEqual(warning?.action?.command, 'startDatabase');

		await h.controller.startDatabase();
		assert.strictEqual(h.executor.requests[0].command, 'docker start carli-db-1');
	});

	test('warns when the database container is published on every interface', async () => {
		const h = harness({ config: testConfig({ database: { dockerContainer: 'carli-db-1' } }) });
		h.engine.exposed = ['0.0.0.0:5432', '[::]:5432'];
		await h.controller.start();
		const warning = h.controller.snapshot().warnings.find((item) => item.message.includes('every network interface'));
		assert.match(warning?.message ?? '', /"carli-db-1" container publishes 0\.0\.0\.0:5432, \[::\]:5432/);

		h.config = testConfig({ database: { dockerContainer: 'carli-db-1', warnIfPortExposed: false } });
		await h.controller.refresh();
		assert.ok(!h.controller.snapshot().warnings.some((item) => item.message.includes('every network interface')));
	});

	test('debug sessions get the environment only while applyToDebugSessions is on', async () => {
		const h = harness();
		await h.controller.start();
		assert.strictEqual(h.envSink.last?.debugSessions, true);
		h.config = testConfig({ applyToDebugSessions: false, applyToTerminals: false });
		await h.controller.refresh();
		assert.strictEqual(h.envSink.last?.debugSessions, false);
		assert.strictEqual(h.envSink.last?.terminals, false);
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

suite('Controller: servers', () => {
	const backend = { id: 'backend', label: 'Backend', command: 'serve', debugConfiguration: 'Backend: FastAPI', restartOnDatabaseChange: true };
	const frontend = { id: 'frontend', label: 'Frontend', command: 'npm run dev', debugConfiguration: 'Frontend: Vite', restartOnDatabaseChange: false };
	const serverConfig = (overrides: { onDatabaseChange?: 'restart' | 'ask' | 'off'; onBranchChange?: 'off' | 'ask' | 'always' } = {}) => testConfig({
		migrations: { command: 'migrate', onBranchChange: overrides.onBranchChange ?? 'off' },
		server: { onDatabaseChange: overrides.onDatabaseChange ?? 'restart', includeLaunchConfigurations: true },
		servers: [backend, frontend],
	});
	function setup(config = serverConfig(), databases = ['postgres', 'app', 'other']) {
		const h = harness({ databases, config });
		h.server.launch = ['Backend: FastAPI', 'Frontend: Vite'];
		return h;
	}

	test('a database change restarts the backend and debug sessions, never the frontend', async () => {
		const h = setup();
		await h.controller.start();
		await h.controller.startServer('backend');
		await h.controller.startServer('frontend');
		h.server.sessions = ['Some Other Launch'];
		await h.controller.switchDatabase('other');
		assert.deepStrictEqual(h.server.events, [
			'start backend: serve @ app',
			'start frontend: npm run dev @ app',
			'restart backend: serve @ other',
			'restart debug Some Other Launch',
		]);
		assert.ok(h.ui.messages('info').includes('Restarted Backend, Some Other Launch on other.'));
		assert.strictEqual(h.server.lastEnv?.OTHER, 'x', 'servers get the env file values too');
	});

	test('a debugged frontend is not restarted on a database change, a debugged backend is', async () => {
		const h = setup();
		await h.controller.start();
		await h.controller.debugServer('backend');
		await h.controller.debugServer('frontend');
		await h.controller.switchDatabase('other');
		assert.deepStrictEqual(h.server.events.slice(-1), ['restart debug Backend: FastAPI']);
	});

	test('nothing is started when nothing is running', async () => {
		const h = setup();
		await h.controller.start();
		await h.controller.switchDatabase('other');
		assert.deepStrictEqual(h.server.events, []);
	});

	test('"off" leaves servers alone and "ask" restarts only when accepted', async () => {
		const off = setup(serverConfig({ onDatabaseChange: 'off' }));
		await off.controller.start();
		await off.controller.startServer('backend');
		await off.controller.switchDatabase('other');
		assert.deepStrictEqual(off.server.events, ['start backend: serve @ app']);

		const ask = setup(serverConfig({ onDatabaseChange: 'ask' }));
		await ask.controller.start();
		await ask.controller.startServer('backend');
		ask.ui.infoAnswer = (message) => (message.startsWith('Now using other. Restart Backend') ? 'Restart' : undefined);
		await ask.controller.switchDatabase('other');
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepStrictEqual(ask.server.events, ['start backend: serve @ app', 'restart backend: serve @ other']);
	});

	test('a branch switch restarts once, after automatic migrations', async () => {
		const h = setup(serverConfig({ onBranchChange: 'always' }), ['postgres', 'app', 'app_x']);
		await h.store.link('x', 'app_x');
		h.git.branches.set('x', 'c-x');
		h.git.branch = 'main';
		await h.controller.start();
		await h.controller.startServer('backend');
		const order: string[] = [];
		h.executor.exitCode = (request) => {
			order.push(`migrate @ ${request.env.DATABASE_URL.split('/').pop()}`);
			return 0;
		};
		const startServer = h.server.startServer.bind(h.server);
		h.server.startServer = async (id: string, label: string, command: string, env: Record<string, string>) => {
			order.push(`server @ ${env.DATABASE_URL.split('/').pop()}`);
			return startServer(id, label, command, env);
		};
		h.git.branch = 'x';
		await h.controller.onGitStateChanged();
		assert.deepStrictEqual(order, ['migrate @ app_x', 'server @ app_x']);
	});

	test('a branch switch without automatic migrations restarts right away', async () => {
		const h = setup(serverConfig({ onBranchChange: 'ask' }), ['postgres', 'app', 'app_x']);
		await h.store.link('x', 'app_x');
		h.git.branches.set('x', 'c-x');
		h.git.branch = 'main';
		await h.controller.start();
		await h.controller.startServer('backend');
		h.git.branch = 'x';
		await h.controller.onGitStateChanged();
		assert.deepStrictEqual(h.server.events, ['start backend: serve @ app', 'restart backend: serve @ app_x']);
		assert.strictEqual(h.executor.requests.length, 0, 'migrations still wait for the answer');
	});

	test('New Database restarts after its migrations', async () => {
		const h = setup(serverConfig(), ['postgres', 'app']);
		await h.controller.start();
		await h.controller.startServer('backend');
		await h.controller.newDatabase();
		assert.deepStrictEqual(h.server.events, ['start backend: serve @ app', 'restart backend: serve @ app_login']);
		assert.strictEqual(h.executor.requests.length, 1);
	});

	test('the first refresh never restarts', async () => {
		const h = setup(serverConfig(), ['postgres', 'app', 'app_login']);
		await h.store.setCurrent('app');
		await h.store.link('feature/login', 'app_login');
		h.server.running.add('backend');
		await h.controller.start();
		assert.deepStrictEqual(h.server.events, []);
	});

	test('debug stops the server\'s terminal first (they share a port), and run stops its debug session', async () => {
		const h = setup();
		await h.controller.start();
		await h.controller.startServer('backend');
		await h.controller.debugServer('backend');
		await h.controller.startServer('backend');
		assert.deepStrictEqual(h.server.events, [
			'start backend: serve @ app',
			'stop backend',
			'debug Backend: FastAPI',
			'stop debug Backend: FastAPI',
			'start backend: serve @ app',
		]);
	});

	test('restart and stop act on the way a server is running', async () => {
		const h = setup();
		await h.controller.start();
		await h.controller.debugServer('backend');
		await h.controller.restartServer('backend');
		assert.deepStrictEqual(h.server.events.slice(-2), ['stop debug Backend: FastAPI', 'debug Backend: FastAPI']);
		await h.controller.stopServer('backend');
		assert.deepStrictEqual(h.server.events.slice(-1), ['stop debug Backend: FastAPI']);
		await h.controller.restartServer('frontend');
		assert.deepStrictEqual(h.server.events.slice(-1), ['start frontend: npm run dev @ app'], 'restarting a stopped server starts it');
		await h.controller.stopServer('frontend');
		assert.deepStrictEqual(h.server.events.slice(-1), ['stop frontend']);
	});

	test('the view shows each server\'s status and buttons', async () => {
		const h = setup();
		h.server.launch = ['Backend: FastAPI'];
		await h.controller.start();
		await h.controller.debugServer('backend');
		await h.controller.startServer('frontend');
		h.server.sessions.push('Unrelated');
		const state = h.controller.snapshot();
		assert.deepStrictEqual(state.servers.map((server) => [server.id, server.status, server.canRun, server.canDebug, server.restartOnDatabaseChange]), [
			['backend', 'debugging', true, true, true],
			['frontend', 'running', true, false, false],
		]);
		assert.deepStrictEqual(state.otherDebugSessions, ['Unrelated']);
		assert.strictEqual(state.serverRestartMode, 'restart');
	});

	test('errors: missing command, missing launch configuration, unknown server, VS Code refusing', async () => {
		const h = harness({ config: testConfig({ servers: [{ id: 'dbg', label: 'Debug only', command: '', debugConfiguration: 'Missing', restartOnDatabaseChange: true }] }) });
		await h.controller.start();
		await h.controller.startServer('dbg');
		await h.controller.debugServer('dbg');
		await h.controller.startServer('nope');
		h.server.launch = ['Missing'];
		h.server.debugStarts = false;
		await h.controller.debugServer('dbg');
		assert.deepStrictEqual(h.ui.messages('error').map((message) => message.replace(/".*?"/g, 'X')), [
			'X has no command; it can only be debugged.',
			'Launch configuration X isn\'t in .vscode/launch.json.',
			'No server with id X in automatedProcesses.servers.',
			'VS Code couldn\'t start X.',
		]);

		const none = harness();
		await none.controller.start();
		await none.controller.startServer();
		assert.match(none.ui.messages('error')[0], /No servers configured/);
		await none.controller.restartServer();
		assert.match(none.ui.messages('info')[0], /Nothing to restart/);
	});
});

suite('Controller: on git update (pull / merge)', () => {
	const deps = { id: 'deps', label: 'Update Dependencies', icon: 'package', env: {}, inputs: {}, steps: [{ label: 'uv', run: 'uv sync --frozen' }, { label: 'npm', run: 'npm ci' }] };
	function setup(onGitUpdate: Partial<{ mode: 'off' | 'ask' | 'always'; whenFilesChange: string[]; skipMainBranches: boolean }> = {}) {
		const h = harness({
			config: testConfig({
				scripts: [deps],
				onGitUpdate: { script: 'deps', mode: 'always', whenFilesChange: ['uv.lock', 'package-lock.json'], skipMainBranches: true, ...onGitUpdate },
			}),
		});
		h.git.commit = 'c1';
		return h;
	}
	async function update(h: ReturnType<typeof setup>, files: string[], to = 'c2') {
		h.git.diffs.set(`${h.git.commit}..${to}`, files);
		h.git.commit = to;
		await h.controller.onGitStateChanged();
	}

	test('runs the script when a watched file changed in a pull/merge on a feature branch', async () => {
		const h = setup();
		await h.controller.start();
		await update(h, ['backend/app.py', 'uv.lock']);
		assert.deepStrictEqual(h.executor.requests.map((request) => request.command), ['uv sync --frozen', 'npm ci']);
		assert.match(h.ui.messages('info')[0], /"feature\/login" was updated and uv\.lock changed\. Running Update Dependencies/);
	});

	test('ignores updates that don\'t touch the watched files', async () => {
		const h = setup();
		await h.controller.start();
		await update(h, ['backend/app.py', 'frontend/src/main.tsx']);
		assert.strictEqual(h.executor.requests.length, 0);
	});

	test('without watched files, every update runs it', async () => {
		const h = setup({ whenFilesChange: [] });
		await h.controller.start();
		await update(h, ['README.md']);
		assert.strictEqual(h.executor.requests.length, 2);
	});

	test('skips main branches when asked to', async () => {
		const h = setup();
		h.git.branch = 'main';
		await h.controller.start();
		await update(h, ['uv.lock']);
		assert.strictEqual(h.executor.requests.length, 0);
		const all = setup({ skipMainBranches: false });
		all.git.branch = 'main';
		await all.controller.start();
		await update(all, ['uv.lock']);
		assert.strictEqual(all.executor.requests.length, 2);
	});

	test('"off" does nothing, "ask" runs only when accepted', async () => {
		const off = setup({ mode: 'off' });
		await off.controller.start();
		await update(off, ['uv.lock']);
		assert.strictEqual(off.executor.requests.length, 0);

		const declined = setup({ mode: 'ask' });
		await declined.controller.start();
		await update(declined, ['uv.lock']);
		assert.strictEqual(declined.executor.requests.length, 0);

		const accepted = setup({ mode: 'ask' });
		accepted.ui.infoAnswer = (_message, actions) => actions[0];
		await accepted.controller.start();
		await update(accepted, ['package-lock.json']);
		assert.strictEqual(accepted.executor.requests.length, 2);
	});

	test('a branch switch is not an update, and the first commit seen never triggers', async () => {
		const h = setup();
		h.git.commit = undefined;
		await h.controller.start();
		h.git.commit = 'c1';
		await h.controller.onGitStateChanged();
		h.git.branch = 'other';
		h.git.branches.set('other', 'c9');
		await update(h, ['uv.lock'], 'c9');
		assert.strictEqual(h.executor.requests.length, 0);
	});

	test('reports a failed run, the footer mode and the setting', async () => {
		const h = setup();
		h.executor.exitCode = () => 1;
		await h.controller.start();
		await update(h, ['uv.lock']);
		assert.match(h.ui.messages('error')[0], /Update Dependencies failed/);
		assert.deepStrictEqual(h.controller.snapshot().gitUpdate, { label: 'Update Dependencies', mode: 'always' });
		await h.controller.setGitUpdateMode('ask');
		assert.deepStrictEqual(h.settings.updates, [['onGitUpdate.mode', 'ask']]);
	});
});

suite('Controller: Sync Migrations', () => {
	const stream = (name: string, query: string, dir: string, command: string, env: Record<string, string> = {}) => ({
		name,
		versionQuery: query,
		versionsPath: dir,
		downgradeCommand: command,
		cwd: 'backend',
		env,
		revisionPattern: DEFAULT_REVISION_PATTERN,
		downRevisionPattern: DEFAULT_DOWN_REVISION_PATTERN,
	});
	const streams = [
		stream('tenant', 'SELECT v FROM t', 'mig', 'down ${revision}', { VENV: '${workspaceFolder}/.venv' }),
		stream('public', 'SELECT v FROM p', 'pub', 'pdown ${revision}'),
	];

	/** This branch has a1 ← a2 and p1; branch "other" also has o1 ← o2 (on a2) and q1 (on p1). */
	function setup(options: { applied?: [string, string]; database?: string; withStreams?: boolean } = {}) {
		const h = harness({
			databases: ['postgres', 'app', 'app_login'],
			config: testConfig({ migrations: { command: 'migrate up', streams: options.withStreams === false ? [] : streams } }),
		});
		const files: [string, string, string | string[] | null][] = [['mig/a1.py', 'a1', null], ['mig/a2.py', 'a2', 'a1'], ['pub/p1.py', 'p1', null]];
		for (const [file, revision, down] of files) {
			h.git.setFile('', file, migration(revision, down));
			h.git.setFile('other', file, migration(revision, down));
		}
		h.git.setFile('other', 'mig/o1.py', migration('o1', 'a2'));
		h.git.setFile('other', 'mig/o2.py', migration('o2', 'o1'));
		h.git.setFile('other', 'pub/q1.py', migration('q1', 'p1'));
		h.git.setFile('', 'mig/__init__.py', '');
		h.git.origins.set('o2', ['feature/login', 'other']);
		h.git.origins.set('q1', ['other']);
		const database = options.database ?? 'app';
		const [tenant, pub] = options.applied ?? ['o2', 'q1'];
		h.engine.results.set(`${database}|SELECT v FROM t`, [[tenant]]);
		h.engine.results.set(`${database}|SELECT v FROM p`, [[pub]]);
		return h;
	}

	test('reverts each stream with the other branch\'s code, then runs this branch\'s migrations', async () => {
		const h = setup();
		await h.controller.start();
		await h.controller.syncMigrations();
		assert.deepStrictEqual(h.ui.messages('error'), []);
		const confirm = h.ui.log.find((entry) => entry.kind === 'confirm');
		assert.strictEqual(confirm?.message, 'Revert migrations from other branches on app?');
		assert.match(confirm?.detail ?? '', /tenant: undo 2 migrations from "other" \(o2, o1\), back to a2\./);
		assert.match(confirm?.detail ?? '', /public: undo 1 migration from "other" \(q1\), back to p1\./);
		assert.deepStrictEqual(
			h.executor.requests.map((request) => [request.command, request.cwd]),
			[
				['down a2', path.join('/tmp/wt-other', 'backend')],
				['pdown p1', path.join('/tmp/wt-other', 'backend')],
				['migrate up', '/repo'],
			],
		);
		assert.strictEqual(h.executor.requests[0].env.VENV, '/repo/.venv', '${workspaceFolder} is the real checkout');
		assert.strictEqual(h.executor.requests[0].env.DATABASE_URL, MAIN_URL);
		assert.deepStrictEqual(h.git.worktreeLog, ['add other', 'remove /tmp/wt-other'], 'one worktree, removed afterwards');
		assert.match(h.ui.messages('info').pop() ?? '', /Reverted tenant to a2, public to p1 on app/);
	});

	test('works on the branch database when the branch has one', async () => {
		const h = setup({ database: 'app_login' });
		await h.store.link('feature/login', 'app_login');
		await h.controller.start();
		await h.controller.syncMigrations();
		assert.ok(h.engine.calls.includes('query app_login: SELECT v FROM t'));
		assert.match(h.executor.requests[0].env.DATABASE_URL, /\/app_login$/);
	});

	test('nothing to do when the database only has known migrations', async () => {
		const h = setup({ applied: ['a2', 'p1'] });
		await h.controller.start();
		await h.controller.syncMigrations();
		assert.match(h.ui.messages('info').pop() ?? '', /Nothing to revert/);
		assert.deepStrictEqual(h.git.worktreeLog, []);
		assert.strictEqual(h.executor.requests.length, 0);
	});

	test('only the stream that has foreign migrations is reverted', async () => {
		const h = setup({ applied: ['o2', 'p1'] });
		await h.controller.start();
		await h.controller.syncMigrations();
		assert.deepStrictEqual(h.executor.requests.map((request) => request.command), ['down a2', 'migrate up']);
	});

	test('cancelling the confirmation changes nothing', async () => {
		const h = setup();
		await h.controller.start();
		h.ui.confirmAnswer = () => false;
		await h.controller.syncMigrations();
		assert.deepStrictEqual(h.git.worktreeLog, []);
		assert.strictEqual(h.executor.requests.length, 0);
	});

	test('a failed revert stops, keeps the remaining streams and still removes the worktree', async () => {
		const h = setup();
		await h.controller.start();
		h.executor.exitCode = (request) => (request.command.startsWith('down') ? 1 : 0);
		await h.controller.syncMigrations();
		assert.match(h.ui.messages('error')[0], /Reverting tenant on app failed/);
		assert.deepStrictEqual(h.executor.requests.map((request) => request.command), ['down a2']);
		assert.deepStrictEqual(h.git.worktreeLog, ['add other', 'remove /tmp/wt-other']);
	});

	test('a migration that is in no branch is reported', async () => {
		const h = setup({ applied: ['zz', 'p1'] });
		await h.controller.start();
		await h.controller.syncMigrations();
		assert.match(h.ui.messages('error')[0], /tenant: migration zz isn't in any branch/);
		assert.deepStrictEqual(h.git.worktreeLog, []);
	});

	test('explains a missing configuration', async () => {
		const h = setup({ withStreams: false });
		await h.controller.start();
		assert.strictEqual(h.controller.snapshot().hasMigrationStreams, false);
		await h.controller.syncMigrations();
		assert.match(h.ui.messages('error')[0], /migrations\.streams/);
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
		await h.controller.setImportDataOnCreate(false);
		await h.controller.setServerRestartMode('ask');
		assert.deepStrictEqual(h.settings.updates, [['migrations.onBranchChange', 'always'], ['database.importDataOnCreate', false], ['server.onDatabaseChange', 'ask']]);
		assert.strictEqual(h.controller.snapshot().importDataOnCreate, true, 'reads the setting');
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
