import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ExtensionMessage, ViewState, WebviewMessage } from '../shared/protocol';

export const SIDEBAR_VIEW_ID = 'automatedProcesses.sidebar';

export class SidebarProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly getState: () => ViewState,
		private readonly onMessage: (message: WebviewMessage) => void,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const assets = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
		view.webview.options = { enableScripts: true, localResourceRoots: [assets] };
		view.webview.html = this.html(view.webview, assets);
		view.webview.onDidReceiveMessage((message: WebviewMessage) => {
			if (message.type === 'ready') {
				this.update();
			} else {
				this.onMessage(message);
			}
		});
		view.onDidChangeVisibility(() => {
			if (view.visible) {
				this.update();
			}
		});
		view.onDidDispose(() => (this.view = undefined));
	}

	update(): void {
		if (this.view?.visible) {
			const message: ExtensionMessage = { type: 'state', state: this.getState() };
			void this.view.webview.postMessage(message);
		}
	}

	private html(webview: vscode.Webview, assets: vscode.Uri): string {
		const nonce = crypto.randomBytes(16).toString('base64');
		const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(assets, file)).toString();
		const csp = [
			"default-src 'none'",
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`font-src ${webview.cspSource}`,
			`img-src ${webview.cspSource} data:`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${asset('codicon.css')}" id="vscode-codicon-stylesheet">
	<link rel="stylesheet" href="${asset('styles.css')}">
	<title>Automated Processes</title>
</head>
<body>
	<div id="app"></div>
	<script nonce="${nonce}" src="${asset('main.js')}"></script>
</body>
</html>`;
	}
}
