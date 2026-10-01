/**
 * Opt-in tests against a real PostgreSQL server. They only create and drop databases named
 * `ap_selftest_*`, plus read (pg_dump) the main database when AP_PG_COPY_MAIN=1.
 *
 *   AP_PG_ROOT=D:\code\carli AP_PG_SERVICE=db npm run test:pg
 *
 * AP_PG_ROOT: folder with the env file (and docker-compose.yml); AP_PG_ENV_FILE (default .env);
 * AP_PG_URL_VARIABLE (default DATABASE_URL); AP_PG_CONTAINER: Docker container (`docker exec`);
 * AP_PG_SERVICE: Compose service. Neither = local tools.
 */
import * as assert from 'assert';
import { databaseName, parseDbUrl } from '../../core/dbUrl';
import { readEnvFile } from '../../core/envFile';
import { clientSpec, isTemplateInUse, PostgresEngine, psqlArgs } from '../../core/postgres';
import { runProcess } from '../../core/process';

const root = process.env.AP_PG_ROOT;
const PREFIX = `ap_selftest_${process.pid}_`;

suite('PostgreSQL (real server)', function () {
	this.timeout(180_000);
	let engine: PostgresEngine;
	let mainName: string;
	const names = { src: `${PREFIX}src`, tpl: `${PREFIX}tpl`, dump: `${PREFIX}dump`, main: `${PREFIX}main` };

	suiteSetup(function () {
		if (!root) {
			this.skip();
		}
		const env = readEnvFile(root!, process.env.AP_PG_ENV_FILE ?? '.env');
		const url = env?.[process.env.AP_PG_URL_VARIABLE ?? 'DATABASE_URL'];
		assert.ok(url, 'database URL not found in the env file');
		const parts = parseDbUrl(url);
		mainName = databaseName(url);
		engine = new PostgresEngine({
			user: parts.user,
			password: parts.password,
			host: parts.host,
			port: parts.port,
			dockerContainer: process.env.AP_PG_CONTAINER || undefined,
			dockerComposeService: process.env.AP_PG_SERVICE || undefined,
			cwd: root!,
			processEnv: process.env,
		});
	});

	suiteTeardown(async () => {
		if (engine) {
			for (const name of Object.values(names)) {
				await engine.drop(name).catch(() => undefined);
			}
		}
	});

	test('lists databases including main', async () => {
		const databases = await engine.listDatabases();
		assert.ok(databases.includes(mainName), databases.join(', '));
	});

	test('template copy carries data and per-database settings', async () => {
		await engine.createEmpty(names.src);
		await engine.query('CREATE TABLE t (id int primary key, name text)', names.src);
		await engine.query("INSERT INTO t VALUES (1, 'it''s copied')", names.src);
		await engine.query(`ALTER DATABASE "${names.src}" SET TimeZone TO 'Europe/London'`);

		await engine.createFromTemplate(names.tpl, names.src);
		await engine.copySettings(names.src, names.tpl);

		assert.deepStrictEqual(await engine.query('SELECT id, name FROM t', names.tpl), [['1', "it's copied"]]);
		assert.deepStrictEqual(await engine.query('SHOW TimeZone', names.tpl), [['Europe/London']]);
	});

	test('a connected template is reported as in use, and connections are listed', async () => {
		// Hold a connection open on the source with a slow query in a separate psql process.
		const holder = runProcess(clientSpec(engine.settings, 'psql', psqlArgs(names.src, "SET application_name = 'ap-holder'; SELECT pg_sleep(8)")));
		await new Promise((resolve) => setTimeout(resolve, 2500));

		const sessions = await engine.connections(names.src);
		assert.ok(sessions.some((session) => session.application === 'ap-holder'), JSON.stringify(sessions));
		await assert.rejects(engine.createFromTemplate(`${PREFIX}blocked`, names.src), (error: Error) => isTemplateInUse(error));

		assert.ok(await engine.terminateConnections(names.src) >= 1);
		await holder;
		assert.deepStrictEqual(await engine.connections(names.src), []);
	});

	test('dump and restore copies a database while it is in use', async () => {
		await engine.createEmpty(names.dump);
		await engine.dumpRestore(names.src, names.dump);
		assert.deepStrictEqual(await engine.query('SELECT name FROM t', names.dump), [["it's copied"]]);
	});

	test('dump and restore of the real main database (read-only on main)', async function () {
		if (process.env.AP_PG_COPY_MAIN !== '1') {
			this.skip();
		}
		await engine.createEmpty(names.main);
		await engine.dumpRestore(mainName, names.main);
		await engine.copySettings(mainName, names.main);
		const source = await engine.query("SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')", mainName);
		const copy = await engine.query("SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')", names.main);
		assert.deepStrictEqual(copy, source);
	});

	test('drop removes databases and tolerates missing ones', async () => {
		await engine.drop(names.tpl);
		await engine.drop(names.tpl);
		assert.ok(!(await engine.listDatabases()).includes(names.tpl));
	});
});
