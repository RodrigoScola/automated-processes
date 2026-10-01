import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { databaseName, parseDbUrl, withDatabase } from '../../core/dbUrl';
import { parseEnvText, readEnvFile } from '../../core/envFile';
import { matchesAnyGlob, matchesGlob } from '../../core/glob';
import { branchIssue, branchShort, sanitizeIdentifier, suggestDatabaseName, testDatabaseName, truncateIdentifier, validateDatabaseName } from '../../core/names';
import { resolveAll, resolvePlaceholders } from '../../core/placeholders';

suite('dbUrl', () => {
	test('parses a driver-qualified URL', () => {
		const parts = parseDbUrl('postgresql+asyncpg://automated:local-only-password@127.0.0.1:5433/automated');
		assert.deepStrictEqual(parts, {
			scheme: 'postgresql+asyncpg',
			user: 'automated',
			password: 'local-only-password',
			host: '127.0.0.1',
			port: 5433,
			database: 'automated',
		});
	});

	test('decodes percent-encoded credentials and keeps @ in passwords', () => {
		const parts = parseDbUrl('postgres://us%40er:p%40ss:word@db.local/app');
		assert.strictEqual(parts.user, 'us@er');
		assert.strictEqual(parts.password, 'p@ss:word');
		assert.strictEqual(parts.host, 'db.local');
		assert.strictEqual(parts.port, undefined);
	});

	test('handles URLs without credentials or database', () => {
		const parts = parseDbUrl('postgres://localhost:5432');
		assert.strictEqual(parts.user, '');
		assert.strictEqual(parts.database, '');
		assert.strictEqual(parts.port, 5432);
	});

	test('swaps only the database name and keeps the query string', () => {
		assert.strictEqual(
			withDatabase('postgresql+asyncpg://u:p@h:5433/app?ssl=require', 'app_347'),
			'postgresql+asyncpg://u:p@h:5433/app_347?ssl=require',
		);
		assert.strictEqual(withDatabase('postgres://u:p@h', 'other'), 'postgres://u:p@h/other');
		assert.strictEqual(databaseName('postgres://u:p@h/x'), 'x');
	});

	test('rejects text that is not a URL', () => {
		assert.throws(() => parseDbUrl('not a url'), /Not a database URL/);
		assert.throws(() => withDatabase('nope', 'x'), /Not a database URL/);
	});
});

suite('names', () => {
	test('branch helpers', () => {
		assert.strictEqual(branchShort('feature/add-login'), 'add-login');
		assert.strictEqual(branchShort('main'), 'main');
		assert.strictEqual(branchIssue('347-carer-leaver-process'), '347');
		assert.strictEqual(branchIssue('rodrigo/12-fix'), '12');
		assert.strictEqual(branchIssue('feature/login'), undefined);
		assert.strictEqual(branchIssue('v2beta'), undefined);
	});

	test('sanitizes identifiers', () => {
		assert.strictEqual(sanitizeIdentifier('Feature/Add-Login!!'), 'feature_add_login');
		assert.strictEqual(sanitizeIdentifier('__a__b__'), 'a_b');
	});

	test('suggests names from patterns', () => {
		assert.strictEqual(suggestDatabaseName('{main}_{issue}', 'automated', '347-carer-leaver-process'), 'automated_347');
		assert.strictEqual(suggestDatabaseName('{main}_{issue}', 'automated', 'bug/save_medicine'), 'automated_save_medicine');
		assert.strictEqual(suggestDatabaseName('{main}_{branchShort}', 'app', 'feature/add-login'), 'app_add_login');
		assert.strictEqual(suggestDatabaseName('{main}_{branch}', 'app', 'feature/x'), 'app_feature_x');
		assert.strictEqual(suggestDatabaseName('{main}_{unknown}', 'app', 'x'), 'app_unknown');
	});

	test('keeps names within 63 characters', () => {
		const name = suggestDatabaseName('{main}_{branchShort}', 'automated', '330-feature-in-app-help-assistant-for-the-dashboard-bottom-right-helper');
		assert.ok(name.length <= 63, name);
		assert.ok(!name.endsWith('_'));
		assert.strictEqual(truncateIdentifier('abc', 2), 'ab');
	});

	test('validates names', () => {
		assert.strictEqual(validateDatabaseName('app_347'), undefined);
		assert.match(validateDatabaseName('') ?? '', /Enter a name/);
		assert.match(validateDatabaseName('App') ?? '', /lowercase/);
		assert.match(validateDatabaseName('1abc') ?? '', /starting/);
		assert.match(validateDatabaseName('a'.repeat(64)) ?? '', /63/);
		assert.strictEqual(testDatabaseName('app_1', '_test'), 'app_1_test');
	});
});

suite('glob', () => {
	test('matches * and ? anchored', () => {
		assert.ok(matchesGlob('automated_test_gw3', '*_test_gw*'));
		assert.ok(matchesGlob('app_test', '*_test'));
		assert.ok(!matchesGlob('app_test_gw1', '*_test'));
		assert.ok(matchesGlob('ab', 'a?'));
		assert.ok(!matchesGlob('abc', 'a?'));
		assert.ok(matchesGlob('a.b', 'a.b'));
		assert.ok(!matchesGlob('axb', 'a.b'));
		assert.ok(matchesAnyGlob('postgres', ['x', 'postgres']));
		assert.ok(!matchesAnyGlob('app', []));
	});
});

suite('envFile', () => {
	test('parses quotes, comments and = in values', () => {
		assert.deepStrictEqual(parseEnvText('A=1\n# comment\nB="x y" # z\nC=a=b\n'), { A: '1', B: 'x y', C: 'a=b' });
	});

	test('reads a file and returns undefined when missing', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-env-'));
		try {
			fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_URL=postgres://u:p@h/db\n');
			assert.deepStrictEqual(readEnvFile(dir, '.env'), { DATABASE_URL: 'postgres://u:p@h/db' });
			assert.strictEqual(readEnvFile(dir, '.env.missing'), undefined);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

suite('placeholders', () => {
	const context = {
		db: { name: 'app_1', url: 'postgres://h/app_1', mainName: 'app', mainUrl: 'postgres://h/app' },
		testDb: { name: 'app_1_test', url: 'postgres://h/app_1_test' },
		env: { HOME: '/home/me' },
		inputs: { suite: 'backend' },
		branch: 'feature/x',
	};

	test('resolves every placeholder kind', () => {
		assert.strictEqual(
			resolvePlaceholders('${db.name} ${db.url} ${db.mainName} ${db.mainUrl} ${testDb.name} ${testDb.url} ${env:HOME} ${input:suite} ${branch}', context),
			'app_1 postgres://h/app_1 app postgres://h/app app_1_test postgres://h/app_1_test /home/me backend feature/x',
		);
	});

	test('leaves unknown placeholders and resolves missing env to empty', () => {
		assert.strictEqual(resolvePlaceholders('${nope} ${input:missing} [${env:MISSING}]', context), '${nope} ${input:missing} []');
		assert.strictEqual(resolvePlaceholders('${testDb.url}', { env: {}, inputs: {} }), '${testDb.url}');
	});

	test('resolves maps', () => {
		assert.deepStrictEqual(resolveAll({ URL: '${db.url}' }, context), { URL: 'postgres://h/app_1' });
	});
});
