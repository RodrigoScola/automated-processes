import * as vscode from 'vscode';
import { EnvMap } from '../core/envFile';
import { ServerControl } from '../core/ports';
import { SKIPPED_DEBUG_TYPES, VsCodeEnvironmentSink } from './environment';
import { DEFAULT_PRESENTATION, Presentation, revealTaskTerminal, TASK_TYPE, taskPresentation } from './taskExecutor';

const TASK_ID_PREFIX = 'server:';
/** Keep the sidebar in place instead of switching to the Run and Debug view. */
const DEBUG_OPTIONS: vscode.DebugSessionOptions = { suppressDebugView: true };
/** How long after a launch a newly focused debug terminal gives focus back. */
const FOCUS_GUARD_MS = 5000;
/** How long after a debug launch (or its terminal opening) the Servers view takes focus back. */
const REFOCUS_DELAY_MS = 500;
const SERVERS_VIEW_ID = 'automatedProcesses.servers';

/**
 * Runs each server as a background task (so its exit is known and it can be stopped), and tracks
 * launch-type debug sessions so they can be started, stopped and restarted with a new environment.
 */
export class VsCodeServer implements ServerControl, vscode.Disposable {
	private readonly executions = new Map<string, vscode.TaskExecution>();
	/** Servers being stopped from here, whose exit isn't a failure. */
	private readonly stopping = new Set<string>();
	private readonly sessions = new Map<string, vscode.DebugSession>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly folder: vscode.WorkspaceFolder | undefined,
		private readonly envSink: VsCodeEnvironmentSink,
		private readonly onDidChange: () => void,
		private readonly presentation: () => Presentation = () => DEFAULT_PRESENTATION,
	) {
		this.disposables.push(
			// A server that crashes (not one stopped from here) shows its terminal with `onFailure`.
			vscode.tasks.onDidEndTaskProcess((event) => {
				const id = serverIdOf(event.execution.task);
				if (id !== undefined && !this.stopping.delete(id) && event.exitCode !== 0 && this.presentation().reveal === 'onFailure') {
					revealTaskTerminal(event.execution.task.name);
				}
			}),
			vscode.tasks.onDidEndTask((event) => {
				const id = serverIdOf(event.execution.task);
				if (id !== undefined && this.executions.get(id) === event.execution) {
					this.executions.delete(id);
					this.onDidChange();
				}
			}),
			vscode.debug.onDidStartDebugSession((session) => {
				if (isRestartable(session)) {
					this.sessions.set(session.id, session);
					this.onDidChange();
				}
			}),
			vscode.debug.onDidTerminateDebugSession((session) => {
				if (this.sessions.delete(session.id)) {
					this.onDidChange();
				}
			}),
		);
		if (vscode.debug.activeDebugSession && isRestartable(vscode.debug.activeDebugSession)) {
			this.sessions.set(vscode.debug.activeDebugSession.id, vscode.debug.activeDebugSession);
		}
	}

	runningServers(): string[] {
		return [...this.executions.keys()];
	}

	async startServer(id: string, label: string, command: string, env: EnvMap, cwd: string): Promise<void> {
		await this.stopAndWait(id);
		const task = new vscode.Task(
			{ type: TASK_TYPE, id: `${TASK_ID_PREFIX}${id}` },
			this.folder ?? vscode.TaskScope.Workspace,
			label,
			'Automated Processes',
			new vscode.ShellExecution(command, { cwd, env }),
		);
		task.isBackground = true;
		task.presentationOptions = taskPresentation(this.presentation(), vscode.TaskPanelKind.Dedicated, true);
		this.executions.set(id, await vscode.tasks.executeTask(task));
		this.onDidChange();
	}

	stopServer(id: string): void {
		const execution = this.executions.get(id);
		if (execution) {
			this.stopping.add(id);
			execution.terminate();
		}
	}

	runningDebugSessions(): string[] {
		return [...this.sessions.values()].map((session) => session.configuration.name);
	}

	launchConfigurations(): string[] {
		return launchConfigurationNames(this.folder);
	}

	async startDebugging(name: string): Promise<boolean> {
		return withoutTerminalFocus(() => vscode.debug.startDebugging(this.folder, name, DEBUG_OPTIONS));
	}

	async stopDebugging(name: string): Promise<void> {
		for (const session of [...this.sessions.values()].filter((item) => item.configuration.name === name)) {
			await stopSessionAndWait(session);
		}
	}

	async restartDebugSessions(skip: string[]): Promise<string[]> {
		const sessions = [...this.sessions.values()].filter((session) => !skip.includes(session.configuration.name));
		const restarted: string[] = [];
		for (const session of sessions) {
			const folder = session.workspaceFolder ?? this.folder;
			const configuration = session.configuration;
			const fromLaunchJson = launchConfigurationNames(folder).includes(configuration.name);
			await stopSessionAndWait(session);
			// By name, launch.json is resolved again, so the debug provider adds the new database.
			// Otherwise relaunch the same configuration with the managed variables refreshed.
			const started = await withoutTerminalFocus(() => fromLaunchJson
				? vscode.debug.startDebugging(folder, configuration.name, DEBUG_OPTIONS)
				: vscode.debug.startDebugging(folder, { ...configuration, env: { ...configuration.env, ...this.envSink.current } }, DEBUG_OPTIONS));
			if (started) {
				restarted.push(configuration.name);
			}
		}
		return restarted;
	}

	private async stopAndWait(id: string): Promise<void> {
		const execution = this.executions.get(id);
		if (!execution) {
			return;
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(done, 5000);
			const listener = vscode.tasks.onDidEndTask((event) => {
				if (event.execution === execution || serverIdOf(event.execution.task) === id) {
					done();
				}
			});
			function done() {
				clearTimeout(timer);
				listener.dispose();
				resolve();
			}
			this.stopping.add(id);
			execution.terminate();
		});
		this.executions.delete(id);
		// Give the OS a moment to release the server's port.
		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	dispose(): void {
		this.disposables.forEach((disposable) => disposable.dispose());
	}
}

function serverIdOf(task: vscode.Task): string | undefined {
	const id = task.definition.type === TASK_TYPE ? task.definition.id : undefined;
	return typeof id === 'string' && id.startsWith(TASK_ID_PREFIX) ? id.slice(TASK_ID_PREFIX.length) : undefined;
}

/** Launch sessions VS Code started from a configuration; browser and extension-host ones excluded. */
function isRestartable(session: vscode.DebugSession): boolean {
	return session.parentSession === undefined
		&& session.configuration.request === 'launch'
		&& !SKIPPED_DEBUG_TYPES.has(session.type);
}

function launchConfigurationNames(folder: vscode.WorkspaceFolder | undefined): string[] {
	const configurations = vscode.workspace.getConfiguration('launch', folder?.uri).get<{ name?: string }[]>('configurations') ?? [];
	return configurations.map((configuration) => configuration.name ?? '').filter(Boolean);
}

/**
 * Runs a debug launch, then gives focus back to the Servers view: VS Code focuses the debug
 * terminal (`"console": "integratedTerminal"`) or console itself, so shortly after the launch,
 * and after any terminal it opens, the sidebar takes focus again. The terminal stays in the panel.
 */
async function withoutTerminalFocus<T>(launch: () => Thenable<T>): Promise<T> {
	const before = new Set(vscode.window.terminals);
	let timer: NodeJS.Timeout | undefined;
	const refocusSoon = () => {
		clearTimeout(timer);
		timer = setTimeout(() => void vscode.commands.executeCommand(`${SERVERS_VIEW_ID}.focus`), REFOCUS_DELAY_MS);
	};
	const onTerminal = (terminal: vscode.Terminal | undefined) => {
		if (terminal && !before.has(terminal)) {
			refocusSoon();
		}
	};
	const listeners = [vscode.window.onDidOpenTerminal(onTerminal), vscode.window.onDidChangeActiveTerminal(onTerminal)];
	const dispose = () => listeners.forEach((listener) => listener.dispose());
	try {
		const result = await launch();
		refocusSoon();
		return result;
	} finally {
		// The debug terminal can open after the launch resolves.
		setTimeout(dispose, FOCUS_GUARD_MS);
	}
}

async function stopSessionAndWait(session: vscode.DebugSession): Promise<void> {
	await new Promise<void>((resolve) => {
		const timer = setTimeout(done, 5000);
		const listener = vscode.debug.onDidTerminateDebugSession((ended) => {
			if (ended.id === session.id) {
				done();
			}
		});
		function done() {
			clearTimeout(timer);
			listener.dispose();
			resolve();
		}
		void vscode.debug.stopDebugging(session);
	});
}
