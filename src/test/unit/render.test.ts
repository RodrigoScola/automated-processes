import * as assert from 'assert';
import { ViewState } from '../../shared/protocol';
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
		scripts: [{ id: 'ci', label: 'Check CI', icon: 'checklist', steps: ['Lint', 'Harness'], inputs: [{ name: 'suite', options: ['backend', 'all'], value: 'all' }] }],
		hasMigrations: true,
		hasMigrationStreams: false,
		onBranchChange: 'ask',
		importDataOnCreate: true,
		server: { configured: false, running: false, debugSessions: [], onDatabaseChange: 'restart' },
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
		assert.match(html, /data-command="migrate" disabled/);
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
		assert.match(renderApp(state({ hiddenCount: 3 })), /Show hidden \(3\)/);
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
		const html = renderApp(state({ server: { configured: true, running: false, debugSessions: [], onDatabaseChange: 'ask' } }));
		assert.match(html, /Import data on database creation[\s\S]*Restart server on database change<\/span>\s*<vscode-single-select class="branch-mode" data-server-restart/);
		assert.match(html, /data-server-restart[\s\S]*<vscode-option value="ask" selected>ask/);
	});

	test('the Export Data button replaces "Migrate"', () => {
		const html = renderApp(state());
		assert.match(html, /data-command="migrate">Export Data</);
		assert.ok(!/>Migrate</.test(html));
	});

	test('server row: hidden when unused, start when stopped, restart/stop when running', () => {
		assert.ok(!renderApp(state()).includes('class="server'));
		const stopped = renderApp(state({ server: { configured: true, running: false, debugSessions: [], onDatabaseChange: 'restart' } }));
		assert.match(stopped, /server stopped/);
		assert.match(stopped, /data-command="startServer"/);
		assert.ok(!stopped.includes('data-command="restartServer"'));
		const running = renderApp(state({ server: { configured: true, running: true, debugSessions: ['Backend: FastAPI'], onDatabaseChange: 'ask' } }));
		assert.match(running, /server running · debugging Backend: FastAPI/);
		assert.match(running, /asks to restart on database change/);
		assert.match(running, /data-command="restartServer"/);
		assert.match(running, /data-command="stopServer"/);
		const debugOnly = renderApp(state({ server: { configured: false, running: false, debugSessions: ['Backend'], onDatabaseChange: 'restart' } }));
		assert.match(debugOnly, /data-command="restartServer"/);
		assert.ok(!debugOnly.includes('data-command="startServer"'));
	});

	test('warns visually when a feature branch uses main', () => {
		const html = renderApp(state({ current: { name: 'app', isMain: true, linked: false, mainName: 'app' } }));
		assert.match(html, /card card-warn/);
		assert.match(html, /pill-main">main/);
	});
});
