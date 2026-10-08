import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_CONFIG } from '../../core/config';
import { databaseName, isSqliteUrl, parseSqliteUrl, withDatabase } from '../../core/dbUrl';
import { buildCommandEnv, engineKind, mainDatabase } from '../../core/environment';
import { SqliteEngine, sqliteFilePath } from '../../core/sqlite';
import { harness, testConfig } from './fakes';

suite('SQLite URLs', () => {
	test('recognises SQLAlchemy, Prisma and bare paths, and nothing else', () => {
		assert.deepStrictEqual(parseSqliteUrl('sqlite:///data/app.db'), { prefix: 'sqlite:///', path: 'data/app.db', suffix: '' });
		assert.deepStrictEqual(parseSqliteUrl('sqlite+aiosqlite:////srv/app.db?timeout=5'), { prefix: 'sqlite+aiosqlite:///', path: '/srv/app.db', suffix: '?timeout=5' });
		assert.deepStrictEqual(parseSqliteUrl('file:./dev.db'), { prefix: 'file:', path: './dev.db', suffix: '' });
		assert.deepStrictEqual(parseSqliteUrl('data\\app.sqlite3'), { prefix: '', path: 'data\\app.sqlite3', suffix: '' });
		assert.strictEqual(parseSqliteUrl('postgresql://u:p@h/app.db'), undefined);
		assert.strictEqual(parseSqliteUrl('not a url'), undefined);
		assert.ok(isSqliteUrl('sqlite:///x.db'));
		assert.strictEqual(engineKind('postgres://h/app'), 'postgres');
	});

	test('the database name is the file name, and other databases are files next to it', () => {
		assert.strictEqual(databaseName('sqlite:///data/app.db'), 'app');
		assert.strictEqual(withDatabase('sqlite:///data/app.db', 'app_347'), 'sqlite:///data/app_347.db');
		assert.strictEqual(withDatabase('file:./dev.db?connection_limit=1', 'dev_x'), 'file:./dev_x.db?connection_limit=1');
		assert.strictEqual(withDatabase('C:\\data\\app.sqlite3', 'b'), 'C:\\data\\b.sqlite3');
		assert.strictEqual(sqliteFilePath('sqlite:///data/app.db', path.resolve('/repo')), path.resolve('/repo/data/app.db'));
		assert.throws(() => sqliteFilePath('postgres://h/x', '/repo'), /Not a SQLite URL/);
	});

	test('mainDatabase checks the URL fits the chosen engine and prefers an entered URL', () => {
		const env = { main: { DATABASE_URL: 'postgres://u:p@h/app' }, test: {} };
		assert.strictEqual(mainDatabase(DEFAULT_CONFIG, env).name, 'app');
		const sqliteConfig = { ...DEFAULT_CONFIG, database: { ...DEFAULT_CONFIG.database, engine: 'sqlite' as const } };
		assert.throws(() => mainDatabase(sqliteConfig, env), /isn't a SQLite URL/);
		const entered = { ...DEFAULT_CONFIG, database: { ...DEFAULT_CONFIG.database, url: 'sqlite:///db/main.db' } };
		assert.deepStrictEqual(mainDatabase(entered, env), { name: 'main', url: 'sqlite:///db/main.db' });
		const postgresConfig = { ...entered, database: { ...entered.database, engine: 'postgres' as const } };
		assert.throws(() => mainDatabase(postgresConfig, env), /SQLite URL, but the engine is PostgreSQL/);
	});

	test('an entered URL replaces the env file\'s variable in commands', () => {
		const config = { ...DEFAULT_CONFIG, database: { ...DEFAULT_CONFIG.database, url: 'sqlite:///db/main.db' } };
		const result = buildCommandEnv({ processEnv: {}, config, env: { main: { DATABASE_URL: 'postgres://old/x' }, test: {} }, database: 'main_2', isMain: false, branch: 'b' });
		assert.strictEqual(result.DATABASE_URL, 'sqlite:///db/main_2.db');
	});
});

suite('SqliteEngine', () => {
	let folder: string;
	let engine: SqliteEngine;

	setup(() => {
		folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-sqlite-'));
		fs.writeFileSync(path.join(folder, 'app.db'), 'main data');
		fs.writeFileSync(path.join(folder, 'app.db-wal'), 'recent writes');
		fs.writeFileSync(path.join(folder, 'notes.txt'), 'not a database');
		engine = new SqliteEngine({ file: path.join(folder, 'app.db'), cwd: folder, processEnv: {} });
	});

	teardown(() => fs.rmSync(folder, { recursive: true, force: true }));

	test('lists files with the main file\'s extension', async () => {
		fs.writeFileSync(path.join(folder, 'app_old.db'), '');
		assert.deepStrictEqual(await engine.listDatabases(), ['app', 'app_old']);
	});

	test('copies with the write-ahead log, creates empty ones and drops with companions', async () => {
		await engine.createFromTemplate('app_347', 'app');
		assert.strictEqual(fs.readFileSync(path.join(folder, 'app_347.db'), 'utf8'), 'main data');
		assert.strictEqual(fs.readFileSync(path.join(folder, 'app_347.db-wal'), 'utf8'), 'recent writes');
		await assert.rejects(engine.createFromTemplate('app_347', 'app'), /already exists/);

		await engine.createEmpty('blank');
		assert.strictEqual(fs.statSync(path.join(folder, 'blank.db')).size, 0);
		await assert.rejects(engine.createEmpty('blank'));

		await engine.drop('app_347');
		await engine.drop('missing');
		assert.deepStrictEqual(await engine.listDatabases(), ['app', 'blank']);
		assert.ok(!fs.existsSync(path.join(folder, 'app_347.db-wal')));
	});

	test('a missing folder is a readable error; nothing is ever connected or exposed', async () => {
		const gone = new SqliteEngine({ file: path.join(folder, 'nope', 'x.db'), cwd: folder, processEnv: {} });
		await assert.rejects(gone.listDatabases(), /SQLite folder .* doesn't exist/);
		assert.deepStrictEqual(await engine.connections(), []);
		assert.strictEqual(await engine.terminateConnections(), 0);
		assert.deepStrictEqual(await engine.exposedAddresses(), []);
	});

	test('query runs sqlite3 against the database file', async () => {
		const ran: string[][] = [];
		const withCli = new SqliteEngine({ file: path.join(folder, 'app.db'), cwd: folder, processEnv: {} }, async (spec) => {
			ran.push([spec.command, ...spec.args]);
			return { code: 0, stdout: 'rev1\nrev2\n', stderr: '' };
		});
		assert.deepStrictEqual(await withCli.query('SELECT version_num FROM alembic_version', 'app_347'), [['rev1'], ['rev2']]);
		assert.strictEqual(ran[0][0], 'sqlite3');
		assert.strictEqual(ran[0][5], path.join(folder, 'app_347.db'));
	});
});

suite('Controller with SQLite', () => {
	test('a SQLite URL gets the SQLite engine, with the file resolved from the workspace', async () => {
		const h = harness({ config: testConfig({ database: { sqliteFolder: 'prisma' } }), env: { main: { DATABASE_URL: 'file:./dev.db' } } });
		h.engine.databases.clear();
		h.engine.databases.add('dev');
		await h.controller.start();
		assert.deepStrictEqual(h.engineKinds, ['sqlite']);
		assert.strictEqual((h.engineSettings[0] as unknown as { file: string }).file, path.resolve('/repo', 'prisma', 'dev.db'));
		assert.strictEqual(h.controller.snapshot().current?.name, 'dev');
	});
});
