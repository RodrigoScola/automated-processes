/** Pure state → HTML rendering for the sidebar. Runs in the webview; unit-tested in Node. */

import { ViewDatabase, ViewRun, ViewRunStep, ViewScript, ViewState } from '../shared/protocol';

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

const e = escapeHtml;

export function relativeTime(iso: string | number | undefined, now: number): string {
	if (iso === undefined) {
		return '';
	}
	const then = typeof iso === 'number' ? iso : Date.parse(iso);
	if (Number.isNaN(then)) {
		return '';
	}
	const seconds = Math.max(0, Math.round((now - then) / 1000));
	if (seconds < 45) {
		return 'just now';
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes} min ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours} h ago`;
	}
	const days = Math.round(hours / 24);
	return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function duration(startedAt: number, finishedAt: number | undefined, now: number): string {
	const total = Math.max(0, Math.round(((finishedAt ?? now) - startedAt) / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

function icon(name: string, extra = ''): string {
	return `<span class="codicon codicon-${e(name)}${extra ? ` ${extra}` : ''}" aria-hidden="true"></span>`;
}

function iconButton(iconName: string, title: string, attrs: string): string {
	return `<button class="icon-button" title="${e(title)}" aria-label="${e(title)}" ${attrs}>${icon(iconName)}</button>`;
}

export function renderApp(state: ViewState, now: number = state.now): string {
	if (!state.hasWorkspace) {
		return `<div class="empty">${icon('folder-opened', 'empty-icon')}<p>Open a folder to use Automated Processes.</p></div>`;
	}
	return [
		state.busy ? '<div class="busy-bar" role="progressbar" aria-label="Working"></div>' : '',
		renderProblems(state),
		renderDatabaseSection(state, now),
		renderScriptsSection(state, now),
		renderFooter(state),
	].join('');
}

function renderProblems(state: ViewState): string {
	if (state.problems.length === 0) {
		return '';
	}
	return `<div class="banner banner-error">${icon('error')}<div><strong>Settings need attention</strong><ul>${state.problems
		.map((problem) => `<li>${e(problem)}</li>`)
		.join('')}</ul><button class="link" data-command="openSettings">Open settings</button></div></div>`;
}

function renderDatabaseSection(state: ViewState, now: number): string {
	const warnings = state.warnings
		.map((warning) => `<div class="banner banner-warn">${icon('warning')}<div>${e(warning.message)}${warning.action
			? ` <button class="link" data-command="${e(warning.action.command)}">${e(warning.action.label)}</button>`
			: ''}</div></div>`)
		.join('');
	const disabled = state.busy || state.dbStatus !== 'ok' ? ' disabled' : '';

	return `<section class="section">
		<header class="section-header">
			<h2>Database</h2>
			<div class="toolbar">${iconButton('refresh', 'Refresh', 'data-command="refresh"')}</div>
		</header>
		${warnings}
		${renderCurrentCard(state, now)}
		<div class="button-row">
			<vscode-button icon="arrow-swap" data-command="migrate"${disabled}>Migrate</vscode-button>
			<vscode-button icon="add" secondary data-command="newDatabase"${disabled}>New Database</vscode-button>
		</div>
		${renderDatabaseList(state)}
	</section>`;
}

function renderCurrentCard(state: ViewState, now: number): string {
	const current = state.current;
	if (!current) {
		return '';
	}
	const rows: string[] = [];
	if (state.branch) {
		rows.push(`<div class="meta">${icon('git-branch')}<span class="truncate" title="${e(state.branch)}">${e(state.branch)}</span></div>`);
	}
	if (current.testName) {
		rows.push(`<div class="meta">${icon('beaker')}<span class="truncate">test: ${e(current.testName)}</span></div>`);
	}
	if (current.lastCopiedFrom) {
		rows.push(`<div class="meta">${icon('history')}<span>copied from ${e(current.lastCopiedFrom)} · ${e(relativeTime(current.lastCopiedAt, now))}</span></div>`);
	}
	if (current.previous && current.previous !== current.name) {
		rows.push(`<div class="meta meta-action">${icon('discard')}<span class="truncate">previous: ${e(current.previous)}</span>
			<button class="link" data-command="switchBack" title="Switch back to ${e(current.previous)}">Switch back</button></div>`);
	}
	const badge = current.isMain
		? '<span class="pill pill-main">main</span>'
		: '<span class="pill pill-branch">branch</span>';
	return `<div class="card${current.isMain && state.branch && !state.isMainBranch ? ' card-warn' : ''}">
		<div class="card-title">${icon('database')}<span class="truncate db-name" title="${e(current.name)}">${e(current.name)}</span>${badge}</div>
		${rows.join('')}
	</div>`;
}

function renderDatabaseList(state: ViewState): string {
	if (state.dbStatus === 'loading' && state.databases.length === 0) {
		return '<div class="hint">Loading databases…</div>';
	}
	if (state.dbStatus === 'error') {
		return `<div class="hint hint-error" title="${e(state.dbError ?? '')}">${e(shorten(state.dbError ?? 'Database unavailable.', 160))}</div>`;
	}
	const rows = state.databases.map((db) => renderDatabaseRow(db, Boolean(state.busy))).join('');
	const toggle = state.hiddenCount > 0
		? `<vscode-checkbox class="hidden-toggle" data-toggle="showHidden"${state.showHidden ? ' checked' : ''}>Show hidden (${state.hiddenCount})</vscode-checkbox>`
		: '';
	return `<div class="subheader">Databases</div><ul class="db-list" role="list">${rows}</ul>${toggle}`;
}

function renderDatabaseRow(db: ViewDatabase, busy: boolean): string {
	const marker = db.isMain ? icon('star-full', 'marker marker-main') : db.isCurrent ? icon('circle-filled', 'marker marker-current') : icon('circle-outline', 'marker');
	const detail = db.isMain ? 'main' : db.branches.length ? db.branches.join(', ') : 'not linked';
	const n = e(db.name);
	const actions = busy ? '' : [
		db.isCurrent ? '' : iconButton('arrow-right', `Use ${db.name} for this branch`, `data-command="switchDatabase" data-database="${n}"`),
		iconButton('export', `Copy ${db.name} into…`, `data-migrate-from="${n}"`),
		iconButton('desktop-download', `Copy … into ${db.name}`, `data-migrate-to="${n}"`),
		db.isMain ? '' : iconButton('trash', `Drop ${db.name}`, `data-command="removeDatabase" data-database="${n}"`),
	].join('');
	return `<li class="db-row${db.isCurrent ? ' is-current' : ''}${db.hidden ? ' is-hidden' : ''}">
		${marker}
		<div class="db-text"><span class="truncate db-name" title="${n}">${n}</span><span class="truncate db-detail" title="${e(detail)}">${e(detail)}</span></div>
		<div class="row-actions">${actions}</div>
	</li>`;
}

function renderScriptsSection(state: ViewState, now: number): string {
	const busy = Boolean(state.busy) || state.run?.status === 'running';
	const scripts = state.scripts.map((script) => renderScript(script, busy)).join('');
	const migrations = state.hasMigrations
		? `<div class="script"><vscode-button icon="arrow-up" secondary data-command="runMigrations"${busy || !state.current ? ' disabled' : ''}>Run Migrations</vscode-button></div>`
		: '';
	const empty = !scripts && !migrations
		? '<div class="hint">No scripts yet. Add them in <button class="link" data-command="openSettings">settings</button> (<code>automatedProcesses.scripts</code>).</div>'
		: '';
	return `<section class="section">
		<header class="section-header"><h2>Scripts</h2></header>
		<div class="scripts">${scripts}${migrations}</div>
		${empty}
		${state.run ? renderRun(state.run, state.scripts, now) : ''}
	</section>`;
}

function renderScript(script: ViewScript, busy: boolean): string {
	const inputs = script.inputs.map((input) => `<vscode-single-select class="script-input" data-script="${e(script.id)}" data-input="${e(input.name)}" title="${e(input.name)}" aria-label="${e(input.name)}">
		${input.options.map((option) => `<vscode-option value="${e(option)}"${option === input.value ? ' selected' : ''}>${e(option)}</vscode-option>`).join('')}
	</vscode-single-select>`).join('');
	return `<div class="script">
		<vscode-button icon="${e(script.icon)}" data-run-script="${e(script.id)}" title="${e(script.steps.join(' → '))}"${busy ? ' disabled' : ''}>${e(script.label)}</vscode-button>
		${inputs}
	</div>`;
}

const STEP_ICONS: Record<ViewRunStep['status'], string> = {
	pending: 'circle-outline',
	running: 'loading',
	passed: 'pass-filled',
	failed: 'error',
	skipped: 'circle-slash',
};

function renderRun(run: ViewRun, scripts: ViewScript[], now: number): string {
	const statusLabel = { running: 'Running', passed: 'Passed', failed: 'Failed', cancelled: 'Cancelled' }[run.status];
	const canRunSteps = run.status !== 'running' && scripts.some((script) => script.id === run.scriptId) && !run.label.includes(' › ');
	const script = scripts.find((item) => item.id === run.scriptId);
	const steps = run.steps.map((step, index) => {
		const stepIndex = script ? script.steps.indexOf(step.label) : -1;
		const rerun = canRunSteps && stepIndex >= 0
			? iconButton('play', `Run only "${step.label}"`, `data-run-script="${e(run.scriptId)}" data-step="${stepIndex}"`)
			: '';
		const output = step.status === 'failed'
			? `<button class="link" data-command="showOutput">output</button>`
			: '';
		const time = step.startedAt ? `<span class="step-time">${e(duration(step.startedAt, step.finishedAt, now))}</span>` : '';
		return `<li class="step step-${step.status}" data-index="${index}">
			${icon(STEP_ICONS[step.status], step.status === 'running' ? 'codicon-modifier-spin' : '')}
			<span class="truncate step-label" title="${e(step.detail ?? step.label)}">${e(step.label)}</span>
			${output}${time}<div class="row-actions">${rerun}</div>
		</li>`;
	}).join('');
	const failedDetail = run.steps.find((step) => step.status === 'failed')?.detail;
	return `<div class="run run-${run.status}">
		<div class="run-header">
			<span class="truncate run-title" title="${e(run.label)}">${e(run.label)}</span>
			<span class="pill pill-${run.status}">${statusLabel}</span>
			<span class="run-time">${e(duration(run.startedAt, run.finishedAt, now))}</span>
			${run.status === 'running' ? iconButton('debug-stop', 'Stop', 'data-command="cancelRun"') : iconButton('terminal', 'Show output', 'data-command="showOutput"')}
		</div>
		<ul class="steps" role="list">${steps}</ul>
		${failedDetail ? `<div class="hint hint-error">${e(failedDetail)}</div>` : ''}
	</div>`;
}

function renderFooter(state: ViewState): string {
	const options = (['off', 'ask', 'always'] as const)
		.map((value) => `<vscode-option value="${value}"${state.onBranchChange === value ? ' selected' : ''}>${value}</vscode-option>`)
		.join('');
	return `<footer class="footer">
		<label class="footer-row"><span>Migrate on branch change</span>
			<vscode-single-select class="branch-mode" data-branch-mode aria-label="Migrate on branch change"${state.hasMigrations ? '' : ' disabled'}>${options}</vscode-single-select>
		</label>
		<button class="link footer-link" data-command="openSettings">${icon('settings-gear')} Settings</button>
	</footer>`;
}

function shorten(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
