import * as vscode from 'vscode';
import { CommandExecutor, CommandRequest } from '../core/scriptRunner';

export const TASK_TYPE = 'automatedProcesses';
const TASK_SOURCE = 'Automated Processes';

/** Runs each command as a VS Code task so its output is visible in a terminal. */
export class TaskExecutor implements CommandExecutor {
	private counter = 0;
	private execution: vscode.TaskExecution | undefined;
	private lastName: string | undefined;

	constructor(private readonly folder: vscode.WorkspaceFolder | undefined) {}

	runCommand(request: CommandRequest): Promise<number> {
		const id = `${Date.now()}-${++this.counter}`;
		const task = new vscode.Task(
			{ type: TASK_TYPE, id },
			this.folder ?? vscode.TaskScope.Workspace,
			request.name,
			TASK_SOURCE,
			new vscode.ShellExecution(request.command, { cwd: request.cwd, env: request.env }),
		);
		task.presentationOptions = {
			reveal: vscode.TaskRevealKind.Always,
			panel: vscode.TaskPanelKind.Shared,
			showReuseMessage: false,
			clear: false,
			focus: false,
			echo: true,
		};
		this.lastName = request.name;

		return new Promise((resolve, reject) => {
			const ended = vscode.tasks.onDidEndTaskProcess((event) => {
				if (event.execution.task.definition.id === id) {
					ended.dispose();
					endedTask.dispose();
					this.execution = undefined;
					resolve(event.exitCode ?? 1);
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
