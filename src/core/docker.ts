import { spawn } from 'child_process';
import * as path from 'path';
import { ProcessSpec, runProcess } from './process';

/** Starting Docker Desktop and waiting for its engine, so a stopped Docker can be fixed from the sidebar. */
export interface DockerControl {
	/** Launches Docker Desktop; rejects when it isn't installed where expected. */
	startDesktop(): Promise<void>;
	/** Resolves true once `docker info` answers, false after `timeoutMs`. */
	waitUntilRunning(timeoutMs: number): Promise<boolean>;
}

/** How each OS starts Docker Desktop. */
export function dockerDesktopLaunch(platform: NodeJS.Platform, env: Record<string, string | undefined>): ProcessSpec {
	if (platform === 'win32') {
		const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
		return { command: path.win32.join(programFiles, 'Docker', 'Docker', 'Docker Desktop.exe'), args: [] };
	}
	if (platform === 'darwin') {
		return { command: 'open', args: ['-a', 'Docker'] };
	}
	return { command: 'systemctl', args: ['--user', 'start', 'docker-desktop'] };
}

export class DockerDesktop implements DockerControl {
	constructor(
		private readonly env: Record<string, string | undefined>,
		private readonly platform: NodeJS.Platform = process.platform,
		private readonly pollMs = 2000,
	) {}

	startDesktop(): Promise<void> {
		const spec = dockerDesktopLaunch(this.platform, this.env);
		return new Promise((resolve, reject) => {
			// Detached: Docker Desktop keeps running after VS Code closes.
			const child = spawn(spec.command, spec.args, { detached: true, stdio: 'ignore', env: this.env as NodeJS.ProcessEnv });
			child.once('error', (error: NodeJS.ErrnoException) => reject(new Error(error.code === 'ENOENT'
				? `Docker Desktop wasn't found (${spec.command}). Start it yourself, then Retry.`
				: `Couldn't start Docker Desktop: ${error.message}`)));
			child.once('spawn', () => {
				child.unref();
				resolve();
			});
		});
	}

	async waitUntilRunning(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const result = await runProcess({ command: 'docker', args: ['info', '--format', '{{.ServerVersion}}'], env: this.env }).catch(() => undefined);
			if (result?.code === 0) {
				return true;
			}
			await new Promise((resolve) => setTimeout(resolve, this.pollMs));
		}
		return false;
	}
}
