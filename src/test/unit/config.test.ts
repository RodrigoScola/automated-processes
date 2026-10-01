import * as assert from 'assert';
import { DEFAULT_CONFIG, readConfig } from '../../core/config';
import { DEFAULT_DOWN_REVISION_PATTERN, DEFAULT_REVISION_PATTERN } from '../../core/migrationSync';

function read(settings: Record<string, unknown>) {
	return readConfig((key) => settings[key]);
}

suite('config', () => {
	test('uses defaults when nothing is set', () => {
		const { config, problems } = read({});
		assert.deepStrictEqual(config, DEFAULT_CONFIG);
		assert.deepStrictEqual(problems, []);
	});

	test('reads every setting', () => {
		const { config, problems } = read({
			envFile: '.env.local',
			loadEnvFileIntoCommands: false,
			env: { A: 'x', N: 3 },
			applyToTerminals: false,
			'database.urlVariables': ['DATABASE_URL', 'DATABASE_ADMIN_URL'],
			'database.mainBranches': ['staging'],
			'database.dockerComposeService': 'db',
			'database.dockerContainer': 'carli-db-1',
			'database.hidePatterns': [],
			'database.newNamePattern': '{main}_{issue}',
			'database.onBranchMerged': 'keep',
			'testDatabase.envFile': '.env.test',
			'testDatabase.urlVariables': ['TEST_DATABASE_URL'],
			'testDatabase.nameSuffix': '_t',
			'migrations.command': 'uv run migrate',
			'migrations.onBranchChange': 'always',
			'migrations.afterCopy': false,
		});
		assert.deepStrictEqual(problems, []);
		assert.strictEqual(config.envFile, '.env.local');
		assert.strictEqual(config.loadEnvFileIntoCommands, false);
		assert.deepStrictEqual(config.env, { A: 'x', N: '3' });
		assert.deepStrictEqual(config.database.urlVariables, ['DATABASE_URL', 'DATABASE_ADMIN_URL']);
		assert.deepStrictEqual(config.database.mainBranches, ['staging']);
		assert.deepStrictEqual(config.database.hidePatterns, []);
		assert.strictEqual(config.database.dockerContainer, 'carli-db-1');
		assert.strictEqual(config.database.dockerComposeService, 'db');
		assert.strictEqual(config.database.onBranchMerged, 'keep');
		assert.strictEqual(config.testDatabase.envFile, '.env.test');
		assert.strictEqual(config.testDatabase.nameSuffix, '_t');
		assert.strictEqual(config.migrations.command, 'uv run migrate');
		assert.strictEqual(config.migrations.onBranchChange, 'always');
		assert.strictEqual(config.migrations.afterCopy, false);
	});

	test('falls back on invalid values', () => {
		const { config } = read({
			'database.onBranchMerged': 'explode',
			'migrations.onBranchChange': 7,
			'database.mainBranches': [],
			envFile: '   ',
		});
		assert.strictEqual(config.database.onBranchMerged, 'delete');
		assert.strictEqual(config.migrations.onBranchChange, 'ask');
		assert.deepStrictEqual(config.database.mainBranches, ['main']);
		assert.strictEqual(config.envFile, '.env');
	});

	test('an empty URL variable list falls back to the default', () => {
		assert.deepStrictEqual(read({ 'database.urlVariables': [] }).config.database.urlVariables, ['DATABASE_URL']);
	});

	test('reads scripts with inputs, env and both step types', () => {
		const { config, problems } = read({
			scripts: [
				{
					id: 'ci',
					label: 'Check CI',
					icon: 'checklist',
					env: { SMOKE: '${db.url}' },
					inputs: { suite: { options: ['backend', 'all'], default: 'all' } },
					steps: [
						{ label: 'Lint', run: 'ruff check' },
						{ copyFile: { from: '.env.example', to: '.env' } },
					],
				},
			],
		});
		assert.deepStrictEqual(problems, []);
		assert.deepStrictEqual(config.scripts, [{
			id: 'ci',
			label: 'Check CI',
			icon: 'checklist',
			env: { SMOKE: '${db.url}' },
			inputs: { suite: { options: ['backend', 'all'], default: 'all' } },
			steps: [
				{ label: 'Lint', run: 'ruff check' },
				{ label: 'Copy .env.example → .env', copyFile: { from: '.env.example', to: '.env', ifMissing: true } },
			],
		}]);
	});

	test('defaults ids, icons and input defaults', () => {
		const { config } = read({
			scripts: [{ label: 'Seed', steps: [{ run: 'seed' }], inputs: { mode: { options: ['a', 'b'], default: 'zzz' } } }],
		});
		assert.strictEqual(config.scripts[0].id, 'Seed');
		assert.strictEqual(config.scripts[0].icon, 'play');
		assert.strictEqual(config.scripts[0].steps[0].label, 'seed');
		assert.strictEqual(config.scripts[0].inputs.mode.default, 'a');
	});

	test('reports broken scripts and keeps the good ones', () => {
		const { config, problems } = read({
			scripts: [
				'nope',
				{ steps: [{ run: 'x' }] },
				{ label: 'Empty', steps: [] },
				{ label: 'Bad step', steps: [{ label: 'nothing' }] },
				{ label: 'Bad input', steps: [{ run: 'x' }], inputs: { s: { options: [] } } },
				{ label: 'Good', steps: [{ run: 'x' }] },
				{ label: 'Good', steps: [{ run: 'y' }] },
			],
		});
		assert.deepStrictEqual(config.scripts.map((script) => script.label), ['Bad input', 'Good']);
		// 'nope', missing label, no steps, bad step (+ no valid steps), bad input, duplicate id.
		assert.strictEqual(problems.length, 7, problems.join('\n'));
		assert.ok(problems.some((problem) => problem.includes('duplicate id "Good"')));
		assert.ok(problems.some((problem) => problem.includes('needs "run" or "copyFile"')));
		assert.ok(problems.some((problem) => problem.includes('non-empty "options"')));
	});

	test('reads migration streams with Alembic defaults and reports incomplete ones', () => {
		const { config, problems } = read({
			'migrations.streams': [
				{ name: 'tenant', versionQuery: 'SELECT 1', versionsPath: 'm', downgradeCommand: 'down ${revision}', cwd: 'backend', env: { A: 'b' } },
				{ versionQuery: 'SELECT 2', versionsPath: 'p', downgradeCommand: 'x', revisionPattern: 'id: (\\w+)' },
				{ name: 'broken', versionQuery: 'SELECT 3' },
			],
		});
		assert.strictEqual(config.migrations.streams.length, 2);
		assert.deepStrictEqual(config.migrations.streams[0], {
			name: 'tenant', versionQuery: 'SELECT 1', versionsPath: 'm', downgradeCommand: 'down ${revision}', cwd: 'backend', env: { A: 'b' },
			revisionPattern: DEFAULT_REVISION_PATTERN, downRevisionPattern: DEFAULT_DOWN_REVISION_PATTERN,
		});
		assert.strictEqual(config.migrations.streams[1].name, 'stream 2');
		assert.strictEqual(config.migrations.streams[1].cwd, '.');
		assert.strictEqual(config.migrations.streams[1].revisionPattern, 'id: (\\w+)');
		assert.deepStrictEqual(problems, ['migrations.streams[2] needs "versionsPath", "downgradeCommand".']);
		assert.deepStrictEqual(read({ 'migrations.streams': 'x' }).problems, ['migrations.streams must be a list.']);
	});

	test('rejects a non-list scripts value and non-string env values', () => {
		const { problems } = read({ scripts: { a: 1 }, env: { A: { nested: true } } });
		assert.ok(problems.some((problem) => problem === 'scripts must be a list.'));
		assert.ok(problems.some((problem) => problem.includes('env.A must be a string')));
	});
});
