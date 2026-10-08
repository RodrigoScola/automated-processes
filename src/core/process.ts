import { spawn } from 'child_process';
import * as fs from 'fs';

export interface ProcessSpec {
	command: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string | undefined>;
	/** Written to stdin, which is then closed. */
	input?: string;
}

export interface ProcessResult {
	code: number;
	stdout: string;
	stderr: string;
}

export class ProcessError extends Error {
	constructor(message: string, readonly result?: ProcessResult) {
		super(message);
	}
}

function spawnChild(spec: ProcessSpec) {
	return spawn(spec.command, spec.args, {
		cwd: spec.cwd,
		env: spec.env as NodeJS.ProcessEnv | undefined,
		shell: false,
		windowsHide: true,
	});
}

function notFound(spec: ProcessSpec, error: NodeJS.ErrnoException): ProcessError {
	if (error.code === 'ENOENT') {
		return new ProcessError(`"${spec.command}" was not found. Is it installed and on PATH?`);
	}
	return new ProcessError(`Could not start "${spec.command}": ${error.message}`);
}

export function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawnChild(spec);
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
		child.on('error', (error) => reject(notFound(spec, error)));
		child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
		child.stdin.on('error', () => undefined);
		child.stdin.end(spec.input ?? '');
	});
}

/** Runs `spec > file`: its output goes straight to `file` (binary-safe, e.g. a pg_dump archive). */
export function runToFile(spec: ProcessSpec, file: string): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawnChild(spec);
		const out = fs.createWriteStream(file);
		let stderr = '';
		let code: number | undefined;
		let flushed = false;
		const finish = () => {
			if (code !== undefined && flushed) {
				resolve({ code, stdout: '', stderr });
			}
		};
		child.on('error', (error) => {
			out.destroy();
			reject(notFound(spec, error));
		});
		child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
		child.stdin.end();
		child.stdout.pipe(out);
		out.on('finish', () => {
			flushed = true;
			finish();
		});
		out.on('error', (error) => {
			child.kill();
			reject(error);
		});
		child.on('close', (exit) => {
			code = exit ?? 1;
			finish();
		});
	});
}

/** Runs `spec < file`: `file` is streamed into its stdin. */
export function runFromFile(spec: ProcessSpec, file: string): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawnChild(spec);
		const input = fs.createReadStream(file);
		let stdout = '';
		let stderr = '';
		child.on('error', (error) => {
			input.destroy();
			reject(notFound(spec, error));
		});
		input.on('error', (error) => {
			child.kill();
			reject(error);
		});
		child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
		child.stdin.on('error', () => undefined);
		input.pipe(child.stdin);
		child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
}

/** Runs `from | to`, streaming stdout of the first into stdin of the second. */
export function pipeProcesses(from: ProcessSpec, to: ProcessSpec): Promise<{ from: ProcessResult; to: ProcessResult }> {
	return new Promise((resolve, reject) => {
		const source = spawnChild(from);
		const sink = spawnChild(to);
		let fromStderr = '';
		let toStdout = '';
		let toStderr = '';
		let fromCode: number | undefined;
		let toCode: number | undefined;
		let failed = false;

		const finish = () => {
			if (fromCode !== undefined && toCode !== undefined && !failed) {
				resolve({
					from: { code: fromCode, stdout: '', stderr: fromStderr },
					to: { code: toCode, stdout: toStdout, stderr: toStderr },
				});
			}
		};
		const fail = (spec: ProcessSpec, error: NodeJS.ErrnoException) => {
			if (!failed) {
				failed = true;
				source.kill();
				sink.kill();
				reject(notFound(spec, error));
			}
		};

		source.on('error', (error) => fail(from, error));
		sink.on('error', (error) => fail(to, error));
		source.stderr.on('data', (chunk: Buffer) => (fromStderr += chunk.toString()));
		sink.stdout.on('data', (chunk: Buffer) => (toStdout += chunk.toString()));
		sink.stderr.on('data', (chunk: Buffer) => (toStderr += chunk.toString()));
		sink.stdin.on('error', () => undefined);
		source.stdin.end();
		source.stdout.pipe(sink.stdin);
		source.on('close', (code) => {
			fromCode = code ?? 1;
			finish();
		});
		sink.on('close', (code) => {
			toCode = code ?? 1;
			finish();
		});
	});
}
