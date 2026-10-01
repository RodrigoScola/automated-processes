import * as vscode from 'vscode';
import { EnvMap } from '../core/envFile';
import { ServerControl } from '../core/ports';
import { SKIPPED_DEBUG_TYPES, VsCodeEnvironmentSink } from './environment';
import { TASK_TYPE } from './taskExecutor';

const SERVER_TASK_NAME = 'Server';
const SERVER_TASK_ID = 'server';

/**
 * Runs the app's server as a background task (so its exit is known and it can be stopped), and
 * tracks launch-type debug sessions so they can be restarted with a new environment.
 */
export class VsCodeServer implements ServerControl, vscode.Disposable {
	private execution: vscode.TaskExecution | undefined;
	private readonly sessions = new Map<string, vscode.DebugSession>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly folder: vscode.WorkspaceFolder | undefined,
		private readonly envSink: VsCodeEnvironmentSink,
		private readonly onDidChange: () => void,
	) {
		this.disposables.push(
			vscode.tasks.onDidEndTask((event) => {
				if (event.execution.task.definition.type === TASK_TYPE && event.execution.task.definition.id === SERVER_TASK_ID) {
					if (this.execution === event.execution || !this.execution) {
						this.execution = undefined;
					}
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

	isServerRunning(): boolean {
		return this.execution !== undefined;
	}

	runningDebugSessions(): string[] {
		return [...this.sessions.values()].map((session) => session.name);
	}

	async startServer(command: string, env: EnvMap, cwd: string): Promise<void> {
		await this.stopAndWait();
		const task = new vscode.Task(
			{ type: TASK_TYPE, id: SERVER_TASK_ID },
			this.folder ?? vscode.TaskScope.Workspace,
			SERVER_TASK_NAME,
			'Automated Processes',
			new vscode.ShellExecution(command, { cwd, env }),
		);
		task.isBackground = true;
		task.presentationOptions = {
			reveal: vscode.TaskRevealKind.Always,
			panel: vscode.TaskPanelKind.Dedicated,
			showReuseMessage: false,
			clear: true,
			focus: false,
			echo: true,
		};
		this.execution = await vscode.tasks.executeTask(task);
		this.onDidChange();
	}

	stopServer(): void {
		this.execution?.terminate();
	}

	async restartDebugSessions(): Promise<string[]> {
		const sessions = [...this.sessions.values()];
		const restarted: string[] = [];
		for (const session of sessions) {
			const folder = session.workspaceFolder ?? this.folder;
			const configuration = session.configuration;
			const fromLaunchJson = launchConfigurationNames(folder).includes(configuration.name);
			await stopSessionAndWait(session);
			// By name, launch.json is resolved again, so the debug provider adds the new database.
			// Otherwise relaunch the same configuration with the managed variables refreshed.
			const started = fromLaunchJson
				? await vscode.debug.startDebugging(folder, configuration.name)
				: await vscode.debug.startDebugging(folder, { ...configuration, env: { ...configuration.env, ...this.envSink.current } });
			if (started) {
				restarted.push(session.name);
			}
		}
		return restarted;
	}

	private async stopAndWait(): Promise<void> {
		const execution = this.execution;
		if (!execution) {
			return;
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(done, 5000);
			const listener = vscode.tasks.onDidEndTask((event) => {
				if (event.execution === execution || event.execution.task.definition.id === SERVER_TASK_ID) {
					done();
				}
			});
			function done() {
				clearTimeout(timer);
				listener.dispose();
				resolve();
			}
			execution.terminate();
		});
		this.execution = undefined;
		// Give the OS a moment to release the server's port.
		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	dispose(): void {
		this.disposables.forEach((disposable) => disposable.dispose());
	}
}

function isRestartable(session: vscode.DebugSession): boolean {
	return session.parentSession === undefined
		&& session.configuration.request === 'launch'
		&& !SKIPPED_DEBUG_TYPES.has(session.type);
}

function launchConfigurationNames(folder: vscode.WorkspaceFolder | undefined): string[] {
	const configurations = vscode.workspace.getConfiguration('launch', folder?.uri).get<{ name?: string }[]>('configurations') ?? [];
	return configurations.map((configuration) => configuration.name ?? '');
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
