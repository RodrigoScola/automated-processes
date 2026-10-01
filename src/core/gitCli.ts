import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runProcess } from './process';

const MAX_MIGRATION_FILE_BYTES = 1024 * 1024;

/** Git operations through the `git` command line, for one repository folder. */
export class GitCli {
	constructor(protected readonly root: string) {}

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

	async listFiles(dir: string, ref?: string): Promise<string[]> {
		if (ref) {
			const output = await this.git(['ls-tree', '-r', '--name-only', ref, '--', toGitPath(dir)]);
			return output.split(/\r?\n/).filter(Boolean);
		}
		return walk(this.root, dir);
	}

	async readFile(file: string, ref?: string): Promise<string> {
		if (ref) {
			return this.git(['show', `${ref}:${toGitPath(file)}`]);
		}
		return fs.promises.readFile(path.join(this.root, file), 'utf8');
	}

	async branchesContaining(text: string, dir: string): Promise<string[]> {
		const commits = (await this.git(['log', '--all', '--format=%H', '-S', text, '--', toGitPath(dir)]))
			.split(/\r?\n/).filter(Boolean);
		// `git log` lists newest first; the oldest match is the commit that added the text.
		const introduced = commits[commits.length - 1];
		if (!introduced) {
			return [];
		}
		const list = async (remote: boolean) => (await this.git(['branch', ...(remote ? ['-r'] : []), '--format=%(refname:short)', '--contains', introduced]))
			.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.endsWith('/HEAD') && !line.startsWith('('));
		return [...await list(false), ...await list(true)];
	}

	async addWorktree(ref: string): Promise<string> {
		const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'automated-processes-'));
		await this.git(['worktree', 'add', '--detach', folder, ref]);
		return folder;
	}

	async removeWorktree(folder: string): Promise<void> {
		await this.git(['worktree', 'remove', '--force', folder]).catch(() => undefined);
		await this.git(['worktree', 'prune']).catch(() => undefined);
		await fs.promises.rm(folder, { recursive: true, force: true }).catch(() => undefined);
	}

	protected async git(args: string[]): Promise<string> {
		const result = await runProcess({ command: 'git', args, cwd: this.root, env: process.env });
		if (result.code !== 0) {
			throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
		}
		return result.stdout;
	}
}

function toGitPath(file: string): string {
	return file.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

/** Files under `dir` (relative to `root`, with `/`), skipping caches and hidden folders. */
async function walk(root: string, dir: string): Promise<string[]> {
	const files: string[] = [];
	const visit = async (relative: string) => {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(path.join(root, relative), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const child = path.join(relative, entry.name);
			if (entry.isDirectory()) {
				if (!entry.name.startsWith('.') && entry.name !== '__pycache__' && entry.name !== 'node_modules') {
					await visit(child);
				}
			} else if (entry.isFile()) {
				const stat = await fs.promises.stat(path.join(root, child));
				if (stat.size <= MAX_MIGRATION_FILE_BYTES) {
					files.push(toGitPath(child));
				}
			}
		}
	};
	await visit(dir);
	return files;
}
