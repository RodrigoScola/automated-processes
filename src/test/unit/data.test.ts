import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_CONFIG, readConfig } from '../../core/config';
import { dockerDesktopLaunch } from '../../core/docker';
import { panelState, upsertScript } from '../../core/editor';
import { ClientSettings, PostgresEngine } from '../../core/postgres';
import { ProcessSpec, runFromFile, runToFile } from '../../core/process';
import { SqliteEngine } from '../../core/sqlite';
import { PanelState } from '../../shared/panelProtocol';
import { databaseDraft, initialScope, matchingIcons, migrationsDraft, PanelUi, renderIconGrid, renderPanel, scriptDraft } from '../../webview/panelRender';
import { BACKUP_FOLDER, harness } from './fakes';

const node = process.execPath;

suite('Backup, export and import', () => {
	test('Backup writes the current database to the backup folder', async () => {
		const h = harness({ databases: ['postgres', 'app', 'app_login'] });
		await h.store.link('feature/login', 'app_login');
		await h.controller.start();
		await h.controller.backupDatabase();
		const call = h.engine.calls.find((item) => item.startsWith('dumpToFile'));
		assert.strictEqual(call, `dumpToFile app_login -> ${path.join(BACKUP_FOLDER, 'app_login-2026-10-01_12-00-00.dump')}`);
		assert.match(h.ui.messages('info').at(-1) ?? '', /Backed up app_login to/);
		assert.ok(fs.existsSync(BACKUP_FOLDER), 'the folder is created');
	});

	test('database.backupFolder puts backups in the workspace', async () => {
		const h = harness({ config: { ...DEFAULT_CONFIG, database: { ...DEFAULT_CONFIG.database, mainBranches: ['main'], backupFolder: 'backups' } } });
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-root-'));
		(h.controller as unknown as { deps: { root: () => string } }).deps.root = () => root;
		await h.controller.start();
		await h.controller.backupDatabase('app');
		assert.ok(h.engine.calls.some((item) => item === `dumpToFile app -> ${path.join(root, 'backups', 'app-2026-10-01_12-00-00.dump')}`));
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('Export Data to a file dumps the picked database where the save dialog says', async () => {
		const h = harness({ databases: ['postgres', 'app', 'app_old'] });
		await h.controller.start();
		h.ui.pickOneAnswer = (<T>(items: { value: T }[], title: string) => (title === 'Export Data' ? items[1].value : items.find((item) => item.value === 'app_old' as unknown)?.value)) as never;
		h.ui.saveAnswer = () => '/exports/old.dump';
		await h.controller.exportData();
		assert.ok(h.engine.calls.includes('dumpToFile app_old -> /exports/old.dump'), h.engine.calls.join('\n'));
	});

	test('Export Data to another database is the database copy', async () => {
		const h = harness({ databases: ['postgres', 'app', 'app_old'] });
		await h.controller.start();
		h.ui.pickOneAnswer = (<T>(items: { value: T }[]) => items[0].value) as never;
		await h.controller.exportData();
		assert.ok(h.ui.messages('confirm').some((message) => /Replace .* with a copy of/.test(message)));
	});

	test('Import Data from a file backs the target up, then replaces it', async () => {
		const h = harness({ databases: ['postgres', 'app', 'app_login'] });
		await h.store.link('feature/login', 'app_login');
		await h.controller.start();
		h.ui.pickOneAnswer = (<T>(items: { value: T }[]) => items[1].value) as never;
		h.ui.openAnswer = () => '/downloads/prod-copy.dump';
		await h.controller.importData();
		const calls = h.engine.calls.filter((item) => !item.startsWith('list') && !item.startsWith('query'));
		assert.deepStrictEqual(calls, [
			`dumpToFile app_login -> ${path.join(BACKUP_FOLDER, 'app_login-2026-10-01_12-00-00.dump')}`,
			'drop app_login',
			'createEmpty app_login',
			'restoreFromFile /downloads/prod-copy.dump -> app_login',
		]);
		assert.match(h.ui.messages('info').at(-1) ?? '', /Imported prod-copy\.dump into app_login\. The previous data is in/);
		assert.strictEqual(h.store.meta('app_login').lastCopiedFrom, 'prod-copy.dump');
	});

	test('a failed import says where the backup is', async () => {
		const h = harness({ databases: ['postgres', 'app', 'app_login'] });
		await h.store.link('feature/login', 'app_login');
		await h.controller.start();
		h.ui.pickOneAnswer = (<T>(items: { value: T }[]) => items[1].value) as never;
		h.ui.openAnswer = () => '/x.dump';
		h.engine.failRestore = new Error('pg_restore failed: not an archive');
		await h.controller.importData();
		assert.match(h.ui.messages('error')[0], /Import failed: pg_restore failed: not an archive app_login was backed up to .*app_login-.*\.dump first/);
	});

	test('importing into main from a feature branch asks twice; cancelling changes nothing', async () => {
		const h = harness();
		await h.controller.start();
		h.ui.pickOneAnswer = (<T>(items: { value: T }[]) => items[1].value) as never;
		h.ui.openAnswer = () => '/x.dump';
		h.ui.confirmAnswer = (message) => !message.startsWith('You are importing into the main database');
		await h.controller.importData();
		assert.ok(h.ui.messages('confirm').some((message) => /importing into the main database/.test(message)));
		assert.ok(!h.engine.calls.some((item) => item.startsWith('drop') || item.startsWith('dumpToFile')));
	});
});

suite('Docker Desktop', () => {
	test('starts the right way on each OS', () => {
		assert.deepStrictEqual(dockerDesktopLaunch('win32', { ProgramFiles: 'D:\\Apps' }), { command: 'D:\\Apps\\Docker\\Docker\\Docker Desktop.exe', args: [] });
		assert.deepStrictEqual(dockerDesktopLaunch('darwin', {}), { command: 'open', args: ['-a', 'Docker'] });
		assert.deepStrictEqual(dockerDesktopLaunch('linux', {}), { command: 'systemctl', args: ['--user', 'start', 'docker-desktop'] });
	});
});

suite('Dump and restore commands', () => {
	const docker: ClientSettings = { user: 'app', password: 'pw', host: '', dockerContainer: 'db-1', cwd: '/repo', processEnv: {} };

	test('Postgres streams pg_dump to the file and the file into pg_restore', async () => {
		const seen: [string, ProcessSpec, string][] = [];
		const ok = { code: 0, stdout: '', stderr: '' };
		const engine = new PostgresEngine(docker, async () => ok, async () => ({ from: ok, to: ok }), {
			toFile: async (spec, file) => (seen.push(['to', spec, file]), ok),
			fromFile: async (spec, file) => (seen.push(['from', spec, file]), ok),
		});
		await engine.dumpToFile('app', '/b/app.dump');
		await engine.restoreFromFile('/b/app.dump', 'app_2');
		assert.deepStrictEqual(seen[0][1].args, ['exec', '-i', '-e', 'PGPASSWORD', 'db-1', 'pg_dump', '-U', 'app', '--format=custom', '--no-password', '-d', 'app']);
		assert.deepStrictEqual(seen[1][1].args.slice(-5), ['--no-password', '--exit-on-error', '--no-owner', '-d', 'app_2']);
		assert.strictEqual(engine.fileExtension, '.dump');

		const failing = new PostgresEngine(docker, async () => ok, async () => ({ from: ok, to: ok }), {
			toFile: async () => ({ code: 1, stdout: '', stderr: 'database "x" does not exist' }),
			fromFile: async () => ok,
		});
		await assert.rejects(failing.dumpToFile('x', '/b/x.dump'), /pg_dump failed .*does not exist/);
	});

	test('runToFile and runFromFile stream bytes unchanged', async () => {
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-stream-'));
		const out = path.join(folder, 'out.bin');
		const bytes = 'process.stdout.write(Buffer.from([0, 255, 10, 13, 128, 1]))';
		assert.strictEqual((await runToFile({ command: node, args: ['-e', bytes] }, out)).code, 0);
		assert.deepStrictEqual([...fs.readFileSync(out)], [0, 255, 10, 13, 128, 1]);
		const read = await runFromFile({ command: node, args: ['-e', 'let n = 0; process.stdin.on("data", (d) => n += d.length); process.stdin.on("end", () => process.stdout.write(String(n)))'] }, out);
		assert.strictEqual(read.stdout, '6');
		fs.rmSync(folder, { recursive: true, force: true });
	});

	test('SQLite backs up to a file and restores from one (without the sqlite3 tool)', async () => {
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-sqlite-backup-'));
		fs.writeFileSync(path.join(folder, 'app.db'), 'main data');
		fs.writeFileSync(path.join(folder, 'app.db-wal'), 'recent');
		const noTool = async () => ({ code: 1, stdout: '', stderr: 'not found' });
		const engine = new SqliteEngine({ file: path.join(folder, 'app.db'), cwd: folder, processEnv: {} }, noTool);
		const backup = path.join(folder, 'backup.db');
		await engine.dumpToFile('app', backup);
		assert.strictEqual(fs.readFileSync(backup, 'utf8'), 'main data');
		assert.strictEqual(fs.readFileSync(backup + '-wal', 'utf8'), 'recent');
		await engine.createEmpty('restored');
		await engine.restoreFromFile(backup, 'restored');
		assert.strictEqual(fs.readFileSync(path.join(folder, 'restored.db'), 'utf8'), 'main data');
		assert.strictEqual(fs.readFileSync(path.join(folder, 'restored.db-wal'), 'utf8'), 'recent');
		assert.strictEqual(engine.fileExtension, '.db');
		await assert.rejects(engine.dumpToFile('missing', backup), /missing\.db not found/);
		fs.rmSync(folder, { recursive: true, force: true });
	});
});

suite('Script triggers and server startup in settings', () => {
	test('reads runOn and runOnStartup, keeping them off by default', () => {
		const { config } = readConfig((key) => ({
			scripts: [
				{ label: 'Deps', steps: [{ run: 'npm ci' }], runOn: { gitUpdate: true, gitUpdatePatterns: ['package-lock.json'], fileSave: false, startup: true } },
				{ label: 'Plain', steps: [{ run: 'x' }] },
			],
			servers: [{ label: 'API', command: 'serve', runOnStartup: true }, { label: 'Web', command: 'vite' }],
		} as Record<string, unknown>)[key]);
		assert.deepStrictEqual(config.scripts[0].runOn, { startup: true, gitUpdate: true, gitUpdatePatterns: ['package-lock.json'] });
		assert.strictEqual(config.scripts[1].runOn, undefined);
		assert.strictEqual(config.servers[0].runOnStartup, true);
		assert.strictEqual(config.servers[1].runOnStartup, undefined);
	});

	test('the old onGitUpdate settings become the script\'s "new commits" trigger', () => {
		const settings: Record<string, unknown> = {
			scripts: [{ id: 'deps', label: 'Deps', steps: [{ run: 'uv sync' }] }],
			'onGitUpdate.script': 'deps',
			'onGitUpdate.whenFilesChange': ['uv.lock'],
		};
		assert.deepStrictEqual(readConfig((key) => settings[key]).config.scripts[0].runOn, { gitUpdate: true, gitUpdatePatterns: ['uv.lock'] });
		assert.strictEqual(readConfig((key) => ({ ...settings, 'onGitUpdate.mode': 'off' })[key]).config.scripts[0].runOn, undefined);
	});

	test('saving a script keeps only the triggers that are on', () => {
		const base = { id: '', label: 'Lint', icon: 'play', env: {}, inputs: {}, steps: [{ label: '', run: 'ruff check' }] };
		const saved = upsertScript([], { ...base, runOn: { startup: false, fileSave: true, fileSavePatterns: [' *.py ', ''], gitUpdate: false, gitUpdatePatterns: ['x'] } });
		assert.ok(Array.isArray(saved));
		assert.deepStrictEqual(saved[0].runOn, { fileSave: true, fileSavePatterns: ['*.py'] });
		const none = upsertScript([], { ...base, runOn: { startup: false } });
		assert.ok(Array.isArray(none) && none[0].runOn === undefined);
	});
});

suite('Configure panel: icons, triggers and the migrations card', () => {
	function state(migrations = { command: '', cwd: '', onBranchChange: 'ask' as const, afterCopy: true, streams: [] }): PanelState {
		return {
			...panelState({ config: DEFAULT_CONFIG, servers: [], launchConfigurations: [], stored: { local: {}, global: {} }, mainUrl: undefined, urlScope: undefined, problems: [], icons: ['add', 'database', 'git-branch', 'git-branch-create', 'rocket'] }),
			migrations,
		};
	}
	function ui(panel: PanelState, overrides: Partial<PanelUi> = {}): PanelUi {
		return { tab: 'scripts', scope: initialScope(panel), db: databaseDraft(panel), dbDirty: false, migrations: migrationsDraft(panel), migrationsDirty: false, iconSearch: '', ...overrides };
	}

	test('icon search matches every word and marks the selected one', () => {
		const icons = state().icons;
		assert.deepStrictEqual(matchingIcons(icons, 'git br'), ['git-branch', 'git-branch-create']);
		assert.deepStrictEqual(matchingIcons(icons, ''), icons);
		assert.match(renderIconGrid(icons, 'rock', 'rocket'), /icon-choice is-selected" data-action="pick-icon" data-id="rocket"/);
		assert.match(renderIconGrid(icons, 'zzz', 'play'), /No icon matches "zzz"/);
	});

	test('the script form has the icon picker and the run-automatically options', () => {
		const panel = state();
		const draft = { ...scriptDraft(), onSave: true };
		const closed = renderPanel(panel, ui(panel, { editing: { kind: 'script', draft } }));
		assert.match(closed, /data-action="icon-toggle"/);
		assert.ok(!/icon-grid/.test(closed));
		assert.match(closed, /data-bind="editing.draft.onStartup"/);
		assert.match(closed, /data-bind="editing.draft.savePatterns"/, 'patterns show once "on save" is ticked');
		assert.ok(!/data-bind="editing.draft.gitPatterns"/.test(closed));
		const open = renderPanel(panel, ui(panel, { editing: { kind: 'script', draft }, iconPicker: true }));
		assert.match(open, /type="search" data-bind="iconSearch"[^>]*placeholder="Search 5 icons/);
	});

	test('the migrations card is folded until set up, with Hide and Remove once it is', () => {
		const empty = state();
		const folded = renderPanel(empty, ui(empty));
		assert.match(folded, /Not set up\./);
		assert.match(folded, /data-action="migrations-open">.*Add migrations/s);
		assert.ok(!/data-bind="migrations.command"/.test(folded));

		const set = state({ command: 'alembic upgrade head', cwd: '', onBranchChange: 'ask', afterCopy: true, streams: [] });
		const open = renderPanel(set, ui(set));
		assert.match(open, /data-bind="migrations.command" value="alembic upgrade head"/);
		assert.match(open, /data-action="remove-migrations"/);
		assert.match(open, /data-action="migrations-close"/);
		const hidden = renderPanel(set, ui(set, { migrationsOpen: false }));
		assert.match(hidden, /Run Migrations: <code>alembic upgrade head<\/code>/);
	});
});
