import * as vscode from 'vscode';
import { PickItem, Ui } from '../core/ports';

export class VsCodeUi implements Ui {
	async info(message: string, ...actions: string[]): Promise<string | undefined> {
		return vscode.window.showInformationMessage(message, ...actions);
	}

	async warn(message: string, ...actions: string[]): Promise<string | undefined> {
		return vscode.window.showWarningMessage(message, ...actions);
	}

	async error(message: string, ...actions: string[]): Promise<string | undefined> {
		return vscode.window.showErrorMessage(message, ...actions);
	}

	async confirm(message: string, detail: string, confirmLabel: string): Promise<boolean> {
		const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, confirmLabel);
		return choice === confirmLabel;
	}

	async choose(message: string, detail: string, options: string[]): Promise<string | undefined> {
		return vscode.window.showWarningMessage(message, { modal: true, detail }, ...options);
	}

	async pickOne<T>(items: PickItem<T>[], title: string, placeholder?: string): Promise<T | undefined> {
		const picker = vscode.window.createQuickPick<vscode.QuickPickItem & { value: T }>();
		picker.title = title;
		picker.placeholder = placeholder;
		picker.items = items;
		const preferred = picker.items.find((_, index) => items[index].picked);
		if (preferred) {
			picker.activeItems = [preferred];
		}
		return new Promise((resolve) => {
			let done = false;
			picker.onDidAccept(() => {
				done = true;
				resolve(picker.selectedItems[0]?.value ?? picker.activeItems[0]?.value);
				picker.hide();
			});
			picker.onDidHide(() => {
				if (!done) {
					resolve(undefined);
				}
				picker.dispose();
			});
			picker.show();
		});
	}

	async pickMany<T>(items: PickItem<T>[], title: string, placeholder?: string): Promise<T[] | undefined> {
		const picked = await vscode.window.showQuickPick(items, { title, placeHolder: placeholder, canPickMany: true });
		return picked?.map((item) => item.value);
	}

	async input(title: string, prompt: string, value: string, validate: (value: string) => string | undefined): Promise<string | undefined> {
		return vscode.window.showInputBox({ title, prompt, value, validateInput: (text) => validate(text.trim()) ?? null })
			.then((text) => text?.trim());
	}

	async withProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
		return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () => task());
	}

	async saveFile(title: string, defaultPath: string): Promise<string | undefined> {
		return (await vscode.window.showSaveDialog({ title, defaultUri: vscode.Uri.file(defaultPath), saveLabel: 'Export' }))?.fsPath;
	}

	async openFile(title: string, folder: string): Promise<string | undefined> {
		const picked = await vscode.window.showOpenDialog({ title, defaultUri: vscode.Uri.file(folder), canSelectMany: false, openLabel: 'Import' });
		return picked?.[0]?.fsPath;
	}

	revealFile(file: string): void {
		void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
	}
}
