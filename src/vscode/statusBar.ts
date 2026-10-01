import * as vscode from 'vscode';
import { ViewState } from '../shared/protocol';
import { SIDEBAR_VIEW_ID } from './sidebar';

export class StatusBar implements vscode.Disposable {
	private readonly item = vscode.window.createStatusBarItem('automatedProcesses.database', vscode.StatusBarAlignment.Left, 50);

	constructor() {
		this.item.name = 'Automated Processes: Current Database';
		this.item.command = `${SIDEBAR_VIEW_ID}.focus`;
	}

	update(state: ViewState): void {
		const current = state.current;
		if (!current) {
			this.item.hide();
			return;
		}
		const icon = state.busy ? '$(sync~spin)' : '$(database)';
		this.item.text = `${icon} ${current.name}`;
		const lines = [
			`**Database:** ${current.name}${current.isMain ? ' (main)' : ''}`,
			state.branch ? `**Branch:** ${state.branch}` : undefined,
			current.testName ? `**Test database:** ${current.testName}` : undefined,
			state.busy ? `_${state.busy}…_` : undefined,
		].filter(Boolean);
		this.item.tooltip = new vscode.MarkdownString(lines.join('\n\n'));
		this.item.backgroundColor = current.isMain && state.branch && !state.isMainBranch
			? new vscode.ThemeColor('statusBarItem.warningBackground')
			: undefined;
		this.item.show();
	}

	dispose(): void {
		this.item.dispose();
	}
}
