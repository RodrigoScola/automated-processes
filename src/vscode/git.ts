import * as path from 'path';
import * as vscode from 'vscode';
import { GitCli } from '../core/gitCli';
import { GitPort } from '../core/ports';

// Minimal slice of the built-in Git extension's API (extensions/git/src/api/git.d.ts).
interface GitHead {
	readonly name?: string;
	readonly commit?: string;
}

interface GitRepositoryState {
	readonly HEAD: GitHead | undefined;
	readonly onDidChange: vscode.Event<void>;
}

interface GitRepository {
	readonly rootUri: vscode.Uri;
	readonly state: GitRepositoryState;
}

interface GitApi {
	readonly repositories: GitRepository[];
	readonly onDidOpenRepository: vscode.Event<GitRepository>;
}

interface GitExtension {
	getAPI(version: 1): GitApi;
}

/**
 * Tracks the repository of one workspace folder through the built-in Git extension (current
 * branch and change events); everything else goes through the git command line.
 */
export class VsCodeGit extends GitCli implements GitPort, vscode.Disposable {
	private repository: GitRepository | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changeEmitter.event;

	async initialize(): Promise<void> {
		const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
		if (!extension) {
			return;
		}
		const api = (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
		const attach = (repository: GitRepository) => {
			if (this.repository || !samePath(repository.rootUri.fsPath, this.root)) {
				return;
			}
			this.repository = repository;
			this.disposables.push(repository.state.onDidChange(() => this.changeEmitter.fire()));
			this.changeEmitter.fire();
		};
		api.repositories.forEach(attach);
		this.disposables.push(api.onDidOpenRepository(attach));
	}

	currentBranch(): string | undefined {
		return this.repository?.state.HEAD?.name;
	}

	dispose(): void {
		this.disposables.forEach((disposable) => disposable.dispose());
		this.changeEmitter.dispose();
	}
}

function samePath(a: string, b: string): boolean {
	const normalize = (value: string) => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
	return normalize(a) === normalize(b);
}
