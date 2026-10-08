import * as assert from 'assert';
import { ViewServer, ViewState } from '../../shared/protocol';
import { duration, escapeHtml, relativeTime, renderApp } from '../../webview/render';

const NOW = Date.parse('2026-10-01T12:00:00Z');

function state(overrides: Partial<ViewState> = {}): ViewState {
	return {
		hasWorkspace: true,
		problems: [],
		warnings: [],
		branch: '347-carer-leaver',
		isMainBranch: false,
		current: {
			name: 'app_347',
			isMain: false,
			linked: true,
			mainName: 'app',
			previous: 'app',
			testName: 'app_347_test',
			lastCopiedFrom: 'app',
			lastCopiedAt: '2026-10-01T10:00:00Z',
		},
		dbStatus: 'ok',
		databases: [
			{ name: 'app', isMain: true, isCurrent: false, isPrevious: true, branches: [], hidden: false },
			{ name: 'app_347', isMain: false, isCurrent: true, isPrevious: false, branches: ['347-carer-leaver'], hidden: false },
		],
		hiddenCount: 0,
		showHidden: false,
		showAll: false,
		moreCount: 0,
		totalDatabases: 2,
		scripts: [{ id: 'ci', label: 'Check CI', icon: 'checklist', steps: ['Lint', 'Harness'], inputs: [{ name: 'suite', options: ['backend', 'all'], value: 'all' }] }],
		hasMigrations: true,
		hasMigrationStreams: false,
		onBranchChange: 'ask',
		importDataOnCreate: true,
		servers: [],
		otherDebugSessions: [],
		serverRestartMode: 'restart',
		canStartDatabase: true,
		now: NOW,
		...overrides,
	};
}

suite('render helpers', () => {
	test('escapes HTML', () => {
		assert.strictEqual(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
	});

	test('relative times', () => {
		assert.strictEqual(relativeTime(NOW - 10_000, NOW), 'just now');
		assert.strictEqual(relativeTime(NOW - 5 * 60_000, NOW), '5 min ago');
		assert.strictEqual(relativeTime('2026-10-01T10:00:00Z', NOW), '2 h ago');
		assert.strictEqual(relativeTime(NOW - 86_400_000, NOW), '1 day ago');
		assert.strictEqual(relativeTime(undefined, NOW), '');
		assert.strictEqual(relativeTime('garbage', NOW), '');
	});

	test('durations', () => {
		assert.strictEqual(duration(0, 9_400, 0), '9s');
		assert.strictEqual(duration(0, 72_000, 0), '1m 12s');
		assert.strictEqual(duration(0, undefined, 3_000), '3s');
	});
});

suite('renderApp', () => {
	test('shows the current database card and the list', () => {
		const html = renderApp(state());
		assert.match(html, /app_347<\/span><span class="pill pill-branch">branch/);
		assert.match(html, /test: app_347_test/);
		assert.match(html, /copied from app · 2 h ago/);
		assert.match(html, /data-command="switchBack"/);
		assert.match(html, /star-full/);
		assert.match(html, /data-migrate-from="app_347"/);
		assert.ok(!/data-command="removeDatabase" data-database="app"/.test(html), 'main has no drop action');
	});

	test('shows scripts with their inputs and the migrations button', () => {
		const html = renderApp(state());
		assert.match(html, /data-run-script="ci"/);
		assert.match(html, /<vscode-option value="all" selected>/);
		assert.match(html, /data-command="runMigrations"/);
		assert.match(html, /<vscode-option value="ask" selected>ask/);
	});

	test('escapes user-controlled text', () => {
		const html = renderApp(state({ branch: '<script>alert(1)</script>' }));
		assert.ok(!html.includes('<script>alert'));
		assert.match(html, /&lt;script&gt;/);
	});

	test('renders warnings, problems and the busy bar', () => {
		const html = renderApp(state({
			busy: 'Copying database',
			problems: ['scripts must be a list.'],
			warnings: [{ message: 'Can\'t reach the database.', action: { label: 'Start Database', command: 'startDatabase' } }],
		}));
		assert.match(html, /busy-bar/);
		assert.match(html, /Settings need attention/);
		assert.match(html, /data-command="startDatabase"/);
		assert.match(html, /data-command="exportData" title="[^"]*" disabled/);
		assert.ok(!html.includes('row-actions"><button'), 'row actions hidden while busy');
	});

	test('renders a failed run with output link and per-step rerun', () => {
		const html = renderApp(state({
			run: {
				scriptId: 'ci',
				label: 'Check CI',
				status: 'failed',
				startedAt: NOW - 70_000,
				finishedAt: NOW,
				steps: [
					{ label: 'Lint', status: 'passed', startedAt: NOW - 70_000, finishedAt: NOW - 60_000 },
					{ label: 'Harness', status: 'failed', detail: 'Exit code 1.', startedAt: NOW - 60_000, finishedAt: NOW },
				],
			},
		}));
		assert.match(html, /pill-failed">Failed/);
		assert.match(html, /1m 10s/);
		assert.match(html, /data-command="showOutput">output/);
		assert.match(html, /data-run-script="ci" data-step="1"/);
		assert.match(html, /Exit code 1\./);
	});

	test('a running script shows a stop button and disables buttons', () => {
		const html = renderApp(state({
			run: { scriptId: 'ci', label: 'Check CI', status: 'running', startedAt: NOW, steps: [{ label: 'Lint', status: 'running', startedAt: NOW }] },
		}));
		assert.match(html, /data-command="cancelRun"/);
		assert.match(html, /codicon-modifier-spin/);
		assert.match(html, /data-run-script="ci" title="Lint → Harness" disabled/);
	});

	test('empty and error states', () => {
		assert.match(renderApp(state({ hasWorkspace: false })), /Open a folder/);
		assert.match(renderApp(state({ scripts: [], hasMigrations: false })), /No scripts yet/);
		assert.match(renderApp(state({ dbStatus: 'error', dbError: 'connection refused', databases: [] })), /connection refused/);
		assert.match(renderApp(state({ dbStatus: 'loading', databases: [] })), /Loading databases/);
		assert.match(renderApp(state({ hiddenCount: 3, showAll: true })), /Show hidden \(3\)/);
		assert.ok(!/Show hidden/.test(renderApp(state({ hiddenCount: 3 }))), 'hidden ones only matter once all are shown');
	});

	test('the list offers the databases beyond main and current', () => {
		assert.match(renderApp(state({ moreCount: 4 })), /data-toggle="showAll">Show all databases \(4 more\)/);
		assert.match(renderApp(state({ showAll: true })), /data-toggle="showAll" checked>Show all databases</);
		assert.ok(!/data-toggle="showAll"/.test(renderApp(state())), 'nothing more to show');
	});

	test('each sidebar view renders only its part', () => {
		const servers: ViewServer[] = [{ id: 'web', label: 'Web', status: 'stopped', canRun: true, canDebug: false, restartOnDatabaseChange: false }];
		const database = renderApp(state({ servers }), NOW, 'database');
		assert.match(database, /Export Data/);
		assert.ok(!/data-command="startServer"/.test(database) && !/data-run-script/.test(database));
		assert.ok(!/section-header/.test(database), 'VS Code shows the view title');

		const serverView = renderApp(state({ servers }), NOW, 'servers');
		assert.match(serverView, /data-command="startServer" data-server="web"/);
		assert.ok(!/Export Data|data-run-script/.test(serverView));
		assert.match(renderApp(state(), NOW, 'servers'), /No servers yet/);

		const scripts = renderApp(state(), NOW, 'scripts');
		assert.match(scripts, /data-run-script="ci"/);
		assert.match(scripts, /data-command="runMigrations"/);
		assert.ok(!/data-command="startServer"/.test(scripts));

		const options = renderApp(state(), NOW, 'options');
		assert.match(options, /data-branch-mode/);
		assert.ok(!/Export Data|data-run-script/.test(options));
	});

	test('every view shows something even with nothing configured', () => {
		const empty = state({ scripts: [], hasMigrations: false, servers: [] });
		const servers = renderApp(empty, NOW, 'servers');
		assert.match(servers, /No servers yet/);
		assert.match(servers, /data-command="configure" data-section="servers:detect">Add defaults/);
		assert.match(servers, /data-section="servers">Add server/);
		const scripts = renderApp(empty, NOW, 'scripts');
		assert.match(scripts, /data-section="scripts:detect">Add defaults/);
		assert.match(renderApp(empty, NOW, 'options'), /data-branch-mode/);

		const noConnection = renderApp(state({ current: undefined, dbStatus: 'unknown', databases: [] }), NOW, 'database');
		assert.match(noConnection, /No database connection\./);
		assert.match(noConnection, /data-section="database">Set up connection/);
		assert.ok(!/Export Data/.test(noConnection));
	});

	test('without a folder, servers, scripts and settings still show', () => {
		const noFolder = state({ hasWorkspace: false, current: undefined, scripts: [], hasMigrations: false });
		assert.match(renderApp(noFolder, NOW, 'database'), /Open a folder/);
		const servers = renderApp(noFolder, NOW, 'servers');
		assert.match(servers, /Add server/);
		assert.ok(!/Add defaults/.test(servers), 'nothing to detect without a folder');
		assert.match(renderApp(noFolder, NOW, 'scripts'), /Add script/);
		assert.match(renderApp(noFolder, NOW, 'options'), /data-branch-mode/);
	});

	test('section headers open the Configure panel on the right tab', () => {
		const html = renderApp(state());
		assert.match(html, /data-command="configure" data-section="database"/);
		assert.match(html, /data-command="configure" data-section="servers"/);
		assert.match(html, /data-command="configure" data-section="scripts"/);
		assert.match(renderApp(state({ scripts: [], hasMigrations: false })), /data-section="scripts">Add script/);
	});

	test('the footer has the import-data toggle below the branch-change mode', () => {
		const on = renderApp(state());
		assert.match(on, /data-branch-mode[\s\S]*Import data on database creation<\/span>\s*<vscode-single-select class="branch-mode" data-import-data/);
		assert.match(on, /<vscode-option value="on" selected>on/);
		const off = renderApp(state({ importDataOnCreate: false }));
		assert.match(off, /<vscode-option value="off" selected>off/);
		assert.ok(!off.includes('<vscode-option value="on" selected>'));
	});

	test('Sync Migrations shows only when streams are configured', () => {
		assert.ok(!renderApp(state()).includes('data-command="syncMigrations"'));
		const html = renderApp(state({ hasMigrationStreams: true }));
		assert.match(html, /data-command="runMigrations"[\s\S]*data-command="syncMigrations" title="Undo migrations other branches applied/);
		assert.match(renderApp(state({ hasMigrationStreams: true, busy: 'x' })), /data-command="syncMigrations"[^>]* disabled/);
	});

	test('the footer has the server restart mode, same style as the others', () => {
		const html = renderApp(state({ serverRestartMode: 'ask' }));
		assert.match(html, /Import data on database creation[\s\S]*Restart server on database change<\/span>\s*<vscode-single-select class="branch-mode" data-server-restart/);
		assert.match(html, /data-server-restart[\s\S]*<vscode-option value="ask" selected>ask/);
	});

	test('the git-update setting moved into the scripts', () => {
		assert.ok(!renderApp(state()).includes('data-git-update'));
	});

	test('the database view has New Database, Backup, Export Data and Import Data', () => {
		const html = renderApp(state());
		assert.match(html, /data-command="newDatabase">New Database</);
		assert.match(html, /data-command="backupDatabase"[^>]*>Backup</);
		assert.match(html, /data-command="exportData"[^>]*>Export Data</);
		assert.match(html, /data-command="importData"[^>]*>Import Data</);
		assert.match(html, /data-command="backupDatabase" data-database="app_347"/);
		assert.ok(!/>Migrate</.test(html));
	});

	const server = (overrides: Partial<ViewServer> = {}): ViewServer => ({
		id: 'backend', label: 'Backend', status: 'stopped', canRun: true, canDebug: true,
		debugConfiguration: 'Backend: FastAPI', restartOnDatabaseChange: true, ...overrides,
	});

	test('no server rows when none are configured or debugging', () => {
		assert.ok(!renderApp(state()).includes('class="server'));
	});

	test('a stopped server has run and debug buttons', () => {
		const html = renderApp(state({ servers: [server()] }));
		assert.match(html, /Backend · stopped/);
		assert.match(html, /data-command="startServer" data-server="backend"/);
		assert.match(html, /title="Debug Backend \(Backend: FastAPI\)"[^>]*data-command="debugServer" data-server="backend"/);
		assert.ok(!html.includes('data-command="restartServer"'));
		assert.ok(!html.includes('data-command="stopServer"'));
	});

	test('running and debugging servers show restart and stop, and the other start mode', () => {
		const html = renderApp(state({ serverRestartMode: 'ask', servers: [
			server({ status: 'running' }),
			server({ id: 'frontend', label: 'Frontend', status: 'debugging', restartOnDatabaseChange: false }),
		] }));
		assert.match(html, /Backend · running[\s\S]*asks to restart on database change/);
		assert.ok(!/data-command="startServer" data-server="backend"/.test(html), 'already running');
		assert.match(html, /data-command="debugServer" data-server="backend"/);
		assert.match(html, /Frontend · debugging[\s\S]*not restarted on database change/);
		assert.match(html, /data-command="startServer" data-server="frontend"/);
		assert.ok(!/data-command="debugServer" data-server="frontend"/.test(html), 'already debugging');
		assert.match(html, /data-command="restartServer" data-server="frontend"/);
		assert.match(html, /data-command="stopServer" data-server="frontend"/);
		assert.match(html, /server is-running is-debugging/);
	});

	test('buttons follow what each server supports, and unrelated debug sessions get a row', () => {
		const html = renderApp(state({
			servers: [server({ canDebug: false }), server({ id: 'dbg', label: 'Debug only', canRun: false })],
			otherDebugSessions: ['Attach to Node'],
		}));
		assert.ok(!/data-command="debugServer" data-server="backend"/.test(html));
		assert.ok(!/data-command="startServer" data-server="dbg"/.test(html));
		assert.match(html, /debugging Attach to Node[\s\S]*data-command="restartServer"/);
	});

	test('warns visually when a feature branch uses main', () => {
		const html = renderApp(state({ current: { name: 'app', isMain: true, linked: false, mainName: 'app' } }));
		assert.match(html, /card card-warn/);
		assert.match(html, /pill-main">main/);
	});
});
