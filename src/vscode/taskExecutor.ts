import * as vscode from 'vscode';
import { RevealMode } from '../core/config';
import { CommandExecutor, CommandRequest } from '../core/scriptRunner';

export const TASK_TYPE = 'automatedProcesses';

/** How task terminals behave, read from the settings each time a task starts. */
export interface Presentation {
	/** Print the command at the top of the terminal (off when commands may hold secrets). */
	echo: boolean;
	reveal: RevealMode;
}

export const DEFAULT_PRESENTATION: Presentation = { echo: true, reveal: 'never' };

/**
 * Task terminals never take focus. With `never` and `onFailure` they're created in the
 * background: the terminal panel and the active terminal stay as they were.
 */
export function taskPresentation(presentation: Presentation, panel: vscode.TaskPanelKind, clear: boolean): vscode.TaskPresentationOptions {
	return {
		reveal: presentation.reveal === 'always' ? vscode.TaskRevealKind.Always : vscode.TaskRevealKind.Never,
		panel,
		showReuseMessage: false,
		clear,
		focus: false,
		echo: presentation.echo,
	};
}

/** Brings a task's terminal into view without moving focus. */
export function revealTaskTerminal(name: string): void {
	const terminal = [...vscode.window.terminals].reverse().find((item) => item.name.includes(name));
	terminal?.show(true);
}
const TASK_SOURCE = 'Automated Processes';

/** Runs each command as a VS Code task so its output is visible in a terminal. */
export class TaskExecutor implements CommandExecutor {
	private counter = 0;
	private execution: vscode.TaskExecution | undefined;
	private lastName: string | undefined;

	constructor(
		private readonly folder: vscode.WorkspaceFolder | undefined,
		private readonly presentation: () => Presentation = () => DEFAULT_PRESENTATION,
	) {}

	runCommand(request: CommandRequest): Promise<number> {
		const id = `${Date.now()}-${++this.counter}`;
		const task = new vscode.Task(
			{ type: TASK_TYPE, id },
			this.folder ?? vscode.TaskScope.Workspace,
			request.name,
			TASK_SOURCE,
			new vscode.ShellExecution(request.command, { cwd: request.cwd, env: request.env }),
		);
		const presentation = this.presentation();
		task.presentationOptions = taskPresentation(presentation, vscode.TaskPanelKind.Shared, false);
		this.lastName = request.name;
		const finish = (code: number) => {
			if (code !== 0 && presentation.reveal === 'onFailure') {
				revealTaskTerminal(request.name);
			}
			return code;
		};

		return new Promise((resolve, reject) => {
			const ended = vscode.tasks.onDidEndTaskProcess((event) => {
				if (event.execution.task.definition.id === id) {
					ended.dispose();
					endedTask.dispose();
					this.execution = undefined;
					resolve(finish(event.exitCode ?? 1));
				}
			});
			// Fires without onDidEndTaskProcess when the task is terminated before its process starts.
			const endedTask = vscode.tasks.onDidEndTask((event) => {
				if (event.execution.task.definition.id === id) {
					setTimeout(() => {
						ended.dispose();
						endedTask.dispose();
						this.execution = undefined;
						resolve(1);
					}, 250);
				}
			});
			vscode.tasks.executeTask(task).then(
				(execution) => (this.execution = execution),
				(error: unknown) => {
					ended.dispose();
					endedTask.dispose();
					reject(error instanceof Error ? error : new Error(String(error)));
				},
			);
		});
	}

	cancel(): void {
		this.execution?.terminate();
	}

	/** Shows the terminal of the most recent step. */
	showOutput(): void {
		const terminals = vscode.window.terminals;
		const match = [...terminals].reverse().find((terminal) => this.lastName && terminal.name.includes(this.lastName))
			?? [...terminals].reverse().find((terminal) => terminal.name.includes(TASK_SOURCE));
		if (match) {
			match.show();
		} else {
			void vscode.commands.executeCommand('workbench.action.terminal.focus');
		}
	}
}
