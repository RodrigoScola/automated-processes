import * as path from 'path';
import * as vscode from 'vscode';
import { GitPort } from '../core/ports';
import { runProcess } from '../core/process';

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

/** Tracks the repository of one workspace folder through the built-in Git extension. */
export class VsCodeGit implements GitPort, vscode.Disposable {
	private repository: GitRepository | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changeEmitter.event;

	constructor(private readonly root: string) {}

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

	async localBranches(): Promise<Map<string, string>> {
		const output = await this.git(['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads']);
		const branches = new Map<string, string>();
		for (const line of output.split(/\r?\n/)) {
			const [name, commit] = line.split('\t');
			if (name && commit) {
				branches.set(name, commit);
			}
		}
		return branches;
	}

	async mergedInto(branch: string): Promise<Set<string>> {
		const output = await this.git(['branch', '--merged', branch, '--format=%(refname:short)']);
		return new Set(output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
	}

	private async git(args: string[]): Promise<string> {
		const result = await runProcess({ command: 'git', args, cwd: this.root, env: process.env });
		if (result.code !== 0) {
			throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
		}
		return result.stdout;
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
