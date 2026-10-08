import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ExtensionMessage, ViewState, WebviewMessage } from '../shared/protocol';

/** The Database view; the other sidebar views are listed in `SIDEBAR_VIEWS`. */
export const SIDEBAR_VIEW_ID = 'automatedProcesses.sidebar';

/** The sidebar's views, each a webview showing one part. VS Code gives them resizable dividers. */
export const SIDEBAR_VIEWS = [
	{ id: SIDEBAR_VIEW_ID, part: 'database' },
	{ id: 'automatedProcesses.servers', part: 'servers' },
	{ id: 'automatedProcesses.scripts', part: 'scripts' },
	{ id: 'automatedProcesses.options', part: 'options' },
] as const;

export class SidebarProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;

	constructor(
		/** Part of the state this view shows, e.g. `servers`. */
		private readonly part: string,
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
<body data-part="${this.part}">
	<div id="app"></div>
	<script nonce="${nonce}" src="${asset('main.js')}"></script>
</body>
</html>`;
	}
}
