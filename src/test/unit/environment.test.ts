import * as assert from 'assert';
import {
	buildCommandEnv,
	buildEnvAdditions,
	databaseOverrides,
	mainDatabase,
	ProjectEnv,
	testDatabaseFor,
} from '../../core/environment';
import { testConfig } from './fakes';

const MAIN = 'postgresql+asyncpg://automated:pw@127.0.0.1:5433/automated';
const ADMIN = 'postgresql+asyncpg://admin:adminpw@127.0.0.1:5433/automated';
const TEST = 'postgresql+asyncpg://automated:pw@127.0.0.1:5433/automated_test';

const env: ProjectEnv = {
	main: { DATABASE_URL: MAIN, DATABASE_ADMIN_URL: ADMIN, CARLI_DB_NAME: 'automated', CARLI_DB_PASSWORD: 'pw' },
	test: { TEST_DATABASE_URL: TEST },
};

const config = testConfig({
	database: { urlVariables: ['DATABASE_URL', 'DATABASE_ADMIN_URL'], mainBranches: ['staging'] },
	testDatabase: { envFile: '.env.test', urlVariables: ['TEST_DATABASE_URL'], nameSuffix: '_test' },
	env: { SMOKE_URL: '${db.url}', BRANCH: '${branch}' },
});

suite('environment', () => {
	test('main database comes from the first URL variable', () => {
		assert.deepStrictEqual(mainDatabase(config, env), { name: 'automated', url: MAIN });
	});

	test('main database errors are readable', () => {
		assert.throws(() => mainDatabase(config, { main: {}, test: {} }), /DATABASE_URL is not set in \.env/);
		assert.throws(() => mainDatabase(config, { main: { DATABASE_URL: 'postgres://h' }, test: {} }), /has no database name/);
	});

	test('overrides keep each variable\'s own credentials', () => {
		assert.deepStrictEqual(databaseOverrides(config, env, 'automated_347', false), {
			DATABASE_URL: 'postgresql+asyncpg://automated:pw@127.0.0.1:5433/automated_347',
			DATABASE_ADMIN_URL: 'postgresql+asyncpg://admin:adminpw@127.0.0.1:5433/automated_347',
			TEST_DATABASE_URL: 'postgresql+asyncpg://automated:pw@127.0.0.1:5433/automated_347_test',
		});
	});

	test('on main, the test URL is the one from the test env file', () => {
		const overrides = databaseOverrides(config, env, 'automated', true);
		assert.strictEqual(overrides.TEST_DATABASE_URL, TEST);
		assert.strictEqual(overrides.DATABASE_URL, MAIN);
	});

	test('a URL variable missing from the env file borrows the main URL', () => {
		const overrides = databaseOverrides(config, { main: { DATABASE_URL: MAIN }, test: {} }, 'x', false);
		assert.strictEqual(overrides.DATABASE_ADMIN_URL, 'postgresql+asyncpg://automated:pw@127.0.0.1:5433/x');
		assert.strictEqual(overrides.TEST_DATABASE_URL, undefined);
	});

	test('test database name and URL', () => {
		assert.deepStrictEqual(testDatabaseFor(config, env, 'automated_347', false), {
			name: 'automated_347_test',
			url: 'postgresql+asyncpg://automated:pw@127.0.0.1:5433/automated_347_test',
		});
		assert.deepStrictEqual(testDatabaseFor(config, env, 'automated', true), { name: 'automated_test', url: TEST });
		assert.strictEqual(testDatabaseFor(testConfig(), env, 'x', false), undefined);
	});

	test('command env layers process → env file → overrides → env → script env', () => {
		const result = buildCommandEnv({
			processEnv: { PATH: '/bin', DATABASE_URL: 'from-shell', UNSET: undefined },
			config,
			env,
			database: 'automated_347',
			isMain: false,
			branch: '347-x',
			scriptEnv: { BRANCH: 'script wins', SUITE: '${input:suite}' },
			inputs: { suite: 'backend' },
		});
		assert.strictEqual(result.PATH, '/bin');
		assert.strictEqual(result.CARLI_DB_PASSWORD, 'pw');
		assert.strictEqual(result.CARLI_DB_NAME, 'automated', 'only URL variables are overridden');
		assert.strictEqual(result.DATABASE_URL, 'postgresql+asyncpg://automated:pw@127.0.0.1:5433/automated_347');
		assert.strictEqual(result.SMOKE_URL, 'postgresql+asyncpg://automated:pw@127.0.0.1:5433/automated_347');
		assert.strictEqual(result.BRANCH, 'script wins');
		assert.strictEqual(result.SUITE, 'backend');
		assert.ok(!('UNSET' in result));
	});

	test('env file values are skipped when loadEnvFileIntoCommands is off', () => {
		const result = buildCommandEnv({
			processEnv: {},
			config: { ...config, loadEnvFileIntoCommands: false },
			env,
			database: 'automated',
			isMain: true,
			branch: 'staging',
		});
		assert.ok(!('CARLI_DB_PASSWORD' in result));
		assert.strictEqual(result.DATABASE_URL, MAIN);
	});

	test('additions contain only what the extension adds', () => {
		const additions = buildEnvAdditions({ processEnv: { PATH: '/bin' }, config, env, database: 'automated_347', isMain: false, branch: 'b' });
		assert.ok(!('PATH' in additions));
		assert.strictEqual(additions.CARLI_DB_PASSWORD, 'pw');
		assert.strictEqual(additions.BRANCH, 'b');
		assert.match(additions.DATABASE_URL, /automated_347$/);
	});

	test('additions leave the env file out when loadEnvFileIntoTerminals is off, but commands keep it', () => {
		const options = { processEnv: {}, config: { ...config, loadEnvFileIntoTerminals: false }, env, database: 'automated_347', isMain: false, branch: 'b' };
		const additions = buildEnvAdditions(options);
		assert.ok(!('CARLI_DB_PASSWORD' in additions));
		assert.match(additions.DATABASE_URL, /automated_347$/);
		assert.strictEqual(additions.BRANCH, 'b');
		assert.strictEqual(buildCommandEnv(options).CARLI_DB_PASSWORD, 'pw');
	});
});
