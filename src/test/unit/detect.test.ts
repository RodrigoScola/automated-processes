import * as assert from 'assert';
import * as path from 'path';
import { DEFAULT_CONFIG, readConfig } from '../../core/config';
import { detectDefaults, ProjectFiles, Suggestion } from '../../core/detect';
import { migrationValues, panelSuggestions, suggestionValues } from '../../core/editor';
import { Overrides } from '../../vscode/overrides';
import { harness, testConfig } from './fakes';
import { MemoryKeyValueStore } from '../../core/store';

/** A project in memory: path → file text. Folders are implied by the paths. */
function project(files: Record<string, string>): ProjectFiles {
	const children = (folder: string) => Object.keys(files)
		.filter((file) => (folder ? file.startsWith(`${folder}/`) : true))
		.map((file) => (folder ? file.slice(folder.length + 1) : file));
	return {
		read: (file) => files[file],
		exists: (file) => file in files || Object.keys(files).some((name) => name.startsWith(`${file}/`)),
		folders: (folder) => [...new Set(children(folder).filter((rest) => rest.includes('/')).map((rest) => rest.split('/')[0]))],
		files: (folder) => children(folder).filter((rest) => !rest.includes('/')),
	};
}

const byId = (suggestions: Suggestion[]) => Object.fromEntries(suggestions.map((item) => [item.id, item]));

suite('detect: Add defaults', () => {
	test('a frontend and a Python backend in subfolders', () => {
		const found = byId(detectDefaults(project({
			'frontend/package.json': JSON.stringify({ scripts: { dev: 'vite', lint: 'eslint .', test: 'vitest', build: 'vite build' }, devDependencies: { vite: '5', react: '18' } }),
			'frontend/pnpm-lock.yaml': '',
			'backend/pyproject.toml': '[project]\ndependencies = ["fastapi>=0.110", "alembic", "uvicorn"]\n[dependency-groups]\ndev = ["pytest", "ruff"]',
			'backend/uv.lock': '',
			'backend/alembic.ini': '[alembic]\nscript_location = %(here)s/migrations\n',
			'backend/app/main.py': 'from fastapi import FastAPI\napp = FastAPI(title="x")\n',
			'backend/app/__init__.py': '',
		}), ['Debug API']));

		const frontend = found['node-server:frontend'];
		assert.ok(frontend?.kind === 'server');
		assert.deepStrictEqual(frontend.server, { id: 'frontend-frontend', label: 'Frontend (frontend)', command: 'pnpm run dev', debugConfiguration: '', restartOnDatabaseChange: false, cwd: 'frontend' });

		const backend = found['python-server:backend'];
		assert.ok(backend?.kind === 'server');
		assert.strictEqual(backend.server.command, 'uv run uvicorn app.main:app --reload');
		assert.strictEqual(backend.server.cwd, 'backend');

		const check = found['node-check:frontend'];
		assert.ok(check?.kind === 'script');
		assert.deepStrictEqual(check.script.steps.map((step) => 'run' in step && step.run), ['pnpm run lint', 'pnpm run test', 'pnpm run build']);
		assert.ok(found['node-install:frontend']?.kind === 'script');
		const python = found['python-check:backend'];
		assert.ok(python?.kind === 'script');
		assert.deepStrictEqual(python.script.steps.map((step) => 'run' in step && step.run), ['uv run ruff check .', 'uv run pytest']);

		const migrations = found['alembic-migrations:backend'];
		assert.ok(migrations?.kind === 'migrations');
		assert.deepStrictEqual([migrations.command, migrations.cwd], ['uv run alembic upgrade head', 'backend']);
		const stream = found['alembic-stream:backend'];
		assert.ok(stream?.kind === 'stream');
		assert.strictEqual(stream.stream.versionsPath, 'backend/migrations/versions');
		assert.strictEqual(stream.stream.downgradeCommand, 'uv run alembic downgrade ${revision}');

		const launch = found['launch:Debug API'];
		assert.ok(launch?.kind === 'server');
		assert.strictEqual(launch.server.debugConfiguration, 'Debug API');
	});

	test('a single Node backend with Prisma at the root', () => {
		const found = byId(detectDefaults(project({
			'package.json': JSON.stringify({ scripts: { start: 'node server.js', test: 'echo "Error: no test specified" && exit 1' }, dependencies: { express: '4', prisma: '5' } }),
			'package-lock.json': '{}',
		})));
		const server = found['node-server:'];
		assert.ok(server?.kind === 'server');
		assert.deepStrictEqual([server.label, server.server.command, server.server.restartOnDatabaseChange, server.server.cwd], ['Backend', 'npm run start', true, undefined]);
		assert.ok(found['node-install:']?.kind === 'script' && found['node-install:'].detail.startsWith('npm ci'));
		assert.strictEqual(found['node-check:'], undefined, 'the placeholder test script is skipped');
		const migrations = found['node-migrations:'];
		assert.ok(migrations?.kind === 'migrations' && migrations.command === 'npx prisma migrate deploy');
	});

	test('Django gets runserver, migrate and its own test runner', () => {
		const found = byId(detectDefaults(project({ 'manage.py': '', 'requirements.txt': 'django==5.0\n', 'shop/settings.py': '' })));
		const server = found['python-server:'];
		assert.ok(server?.kind === 'server' && server.server.command === 'python manage.py runserver');
		const migrations = found['django-migrations:'];
		assert.ok(migrations?.kind === 'migrations' && migrations.command === 'python manage.py migrate');
		const install = found['python-install:'];
		assert.ok(install?.kind === 'script' && install.detail === 'pip install -r requirements.txt');
	});

	test('nothing to find', () => {
		assert.deepStrictEqual(detectDefaults(project({ 'README.md': '# hi' })), []);
	});
});

suite('editor: migrations and suggestions', () => {
	const suggestions = detectDefaults(project({
		'package.json': JSON.stringify({ scripts: { dev: 'next dev', lint: 'next lint' }, dependencies: { next: '14' } }),
		'api/manage.py': '',
		'api/requirements.txt': 'django\n',
	}), ['Debug']);

	test('marks what is already there and splits by tab', () => {
		const config = { ...DEFAULT_CONFIG, scripts: [{ id: 'x', label: 'Install dependencies', icon: 'play', env: {}, inputs: {}, steps: [{ label: 'a', run: 'a' }] }] };
		const servers = [{ id: 'web', label: 'Web', command: 'npm run dev', debugConfiguration: '', restartOnDatabaseChange: false }];
		const forServers = panelSuggestions(suggestions, config, servers, 'servers');
		assert.deepStrictEqual(forServers.map((item) => [item.id, item.exists]), [['node-server:', true], ['python-server:api', false], ['launch:Debug', false]]);
		const forScripts = panelSuggestions(suggestions, config, servers, 'scripts');
		assert.ok(forScripts.every((item) => item.kind !== 'server'));
		assert.ok(forScripts.find((item) => item.id === 'node-install:')?.exists);
	});

	test('adding picked suggestions appends servers and scripts and sets migrations', () => {
		const config = testConfig({ servers: [{ id: 'old', label: 'Old', command: 'x', debugConfiguration: '', restartOnDatabaseChange: true }] });
		const servers = suggestionValues(suggestions, ['python-server:api', 'launch:Debug'], config, 'servers');
		const read = readConfig((key) => (servers as Record<string, unknown>)[key]).config.servers;
		assert.deepStrictEqual(read.map((server) => [server.label, server.command, server.cwd]), [['Old', 'x', undefined], ['Backend (api)', 'python manage.py runserver', 'api'], ['Debug', '', undefined]]);

		const scripts = suggestionValues(suggestions, ['node-install:', 'django-migrations:api'], config, 'scripts');
		assert.deepStrictEqual([scripts['migrations.command'], scripts['migrations.cwd']], ['python manage.py migrate', 'api']);
		assert.deepStrictEqual((scripts.scripts as { label: string }[]).map((script) => script.label), ['Install dependencies']);
	});

	test('migration form values are checked', () => {
		const form = { command: ' alembic upgrade head ', cwd: './backend/', onBranchChange: 'always' as const, afterCopy: false, streams: [{ name: '', versionQuery: 'SELECT 1', versionsPath: 'backend\\versions', downgradeCommand: 'alembic downgrade ${revision}', cwd: '' }] };
		assert.deepStrictEqual(migrationValues(form), {
			'migrations.command': 'alembic upgrade head',
			'migrations.cwd': 'backend',
			'migrations.onBranchChange': 'always',
			'migrations.afterCopy': false,
			'migrations.streams': [{ name: 'history 1', versionQuery: 'SELECT 1', versionsPath: 'backend/versions', downgradeCommand: 'alembic downgrade ${revision}', cwd: '.' }],
		});
		assert.match(migrationValues({ ...form, streams: [{ ...form.streams[0], downgradeCommand: 'alembic downgrade -1' }] }) as string, /\$\{revision\}/);
		assert.match(migrationValues({ ...form, streams: [{ ...form.streams[0], versionQuery: '' }] }) as string, /history 1 needs/);
	});
});

suite('Overrides: this workspace and all workspaces', () => {
	function overrides() {
		const secrets = new Map<string, string>();
		const store = {
			get: async (key: string) => secrets.get(key),
			store: async (key: string, value: string) => void secrets.set(key, value),
			delete: async (key: string) => void secrets.delete(key),
		};
		const states = { local: new MemoryKeyValueStore(), global: new MemoryKeyValueStore() };
		// Only the Memento/SecretStorage methods the store uses are needed.
		return new Overrides(states as never, store as never, { uri: { toString: () => 'file:///repo' } } as never);
	}

	test('this workspace wins; saving for all workspaces clears it here', async () => {
		const o = overrides();
		await o.set({ scripts: ['global'] }, 'global');
		await o.set({ scripts: ['local'], envFile: '.env.local' }, 'local');
		assert.deepStrictEqual(o.values(), { scripts: ['local'], envFile: '.env.local' });
		await o.set({ scripts: ['everywhere'] }, 'global');
		assert.deepStrictEqual(o.values(), { scripts: ['everywhere'], envFile: '.env.local' });
		assert.deepStrictEqual(o.stored('local'), { envFile: '.env.local' });
		await o.clear(['scripts', 'envFile']);
		assert.deepStrictEqual(o.values(), {});
	});

	test('the URL lives in secret storage per layer', async () => {
		const o = overrides();
		await o.setUrl('postgres://u:p@h/global', 'global');
		assert.strictEqual(o.urlScope(), 'global');
		await o.setUrl('postgres://u:p@h/here', 'local');
		assert.deepStrictEqual([o.urlScope(), o.values()['database.url']], ['local', 'postgres://u:p@h/here']);
		await o.clearUrl();
		assert.strictEqual(o.urlScope(), undefined);
		assert.ok(!('database.url' in o.values()));
	});
});

suite('Controller: folders', () => {
	test('servers, scripts and migrations run in their folders', async () => {
		const h = harness({
			config: testConfig({
				migrations: { command: 'migrate', cwd: 'backend' },
				servers: [{ id: 'web', label: 'Web', command: 'npm run dev', debugConfiguration: '', restartOnDatabaseChange: false, cwd: 'frontend' }],
				scripts: [{ id: 'lint', label: 'Lint', icon: 'play', cwd: 'frontend', env: {}, inputs: {}, steps: [{ label: 'lint', run: 'npm run lint' }] }],
			}),
		});
		await h.controller.start();
		await h.controller.runScript('lint');
		await h.controller.runMigrations();
		const cwds: string[] = [];
		const server = h.server as unknown as { startServer: (...args: unknown[]) => Promise<void> };
		const original = server.startServer.bind(h.server);
		server.startServer = async (...args: unknown[]) => {
			cwds.push(args[4] as string);
			return original(...args);
		};
		await h.controller.startServer('web');
		assert.deepStrictEqual(h.executor.requests.map((request) => request.cwd), [path.resolve('/repo', 'frontend'), path.resolve('/repo', 'backend')]);
		assert.deepStrictEqual(cwds, [path.resolve('/repo', 'frontend')]);
	});

	test('reads revealTerminal and folders from settings', () => {
		const { config } = readConfig((key) => ({ revealTerminal: 'onFailure', 'migrations.cwd': 'api', servers: [{ label: 'A', command: 'a', cwd: 'web' }] } as Record<string, unknown>)[key]);
		assert.strictEqual(config.revealTerminal, 'onFailure');
		assert.strictEqual(config.migrations.cwd, 'api');
		assert.strictEqual(config.servers[0].cwd, 'web');
		assert.strictEqual(readConfig(() => undefined).config.revealTerminal, 'never');
		assert.strictEqual(readConfig(() => undefined).config.server.includeLaunchConfigurations, false);
	});
});
