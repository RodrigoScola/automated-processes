import * as fs from 'fs';
import * as path from 'path';
import { ScriptDefinition, ScriptStep } from './config';
import { EnvMap } from './envFile';
import { PlaceholderContext, resolvePlaceholders } from './placeholders';

export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
export type RunStatus = 'running' | 'passed' | 'failed' | 'cancelled';

export interface StepState {
	label: string;
	status: StepStatus;
	detail?: string;
	startedAt?: number;
	finishedAt?: number;
}

export interface RunState {
	scriptId: string;
	label: string;
	status: RunStatus;
	startedAt: number;
	finishedAt?: number;
	steps: StepState[];
}

export interface CommandRequest {
	/** Display name, e.g. `Check CI › Lint`. */
	name: string;
	command: string;
	env: EnvMap;
	cwd: string;
}

/** Runs one shell command and resolves with its exit code. */
export interface CommandExecutor {
	runCommand(request: CommandRequest): Promise<number>;
	cancel?(): void;
}

export interface FileOps {
	exists(file: string): boolean;
	copy(from: string, to: string): void;
}

export const nodeFileOps: FileOps = {
	exists: (file) => fs.existsSync(file),
	copy: (from, to) => fs.copyFileSync(from, to),
};

export interface RunOptions {
	env: EnvMap;
	cwd: string;
	context: PlaceholderContext;
	/** Run only this step (index into `script.steps`). */
	onlyStep?: number;
}

export class ScriptRunner {
	private current: RunState | undefined;
	private cancelled = false;

	constructor(
		private readonly executor: CommandExecutor,
		private readonly onChange: (state: RunState) => void = () => undefined,
		private readonly files: FileOps = nodeFileOps,
		private readonly clock: () => number = Date.now,
	) {}

	get running(): boolean {
		return this.current?.status === 'running';
	}

	get lastRun(): RunState | undefined {
		return this.current;
	}

	cancel(): void {
		if (this.running) {
			this.cancelled = true;
			this.executor.cancel?.();
		}
	}

	async run(script: ScriptDefinition, options: RunOptions): Promise<RunState> {
		if (this.running) {
			throw new Error(`"${this.current?.label}" is still running.`);
		}
		const selected: ScriptStep[] = options.onlyStep === undefined
			? script.steps
			: [script.steps[options.onlyStep]].filter((step): step is ScriptStep => step !== undefined);
		if (selected.length === 0) {
			throw new Error(`"${script.label}" has no step ${options.onlyStep}.`);
		}

		this.cancelled = false;
		const state: RunState = {
			scriptId: script.id,
			label: options.onlyStep === undefined ? script.label : `${script.label} › ${selected[0].label}`,
			status: 'running',
			startedAt: this.clock(),
			steps: selected.map((step) => ({ label: step.label, status: 'pending' })),
		};
		this.current = state;
		this.emit();

		for (let index = 0; index < selected.length; index++) {
			const step = selected[index];
			const stepState = state.steps[index];
			if (this.cancelled) {
				break;
			}
			stepState.status = 'running';
			stepState.startedAt = this.clock();
			this.emit();
			try {
				const outcome = await this.runStep(script, step, options);
				stepState.status = outcome.status;
				stepState.detail = outcome.detail;
			} catch (error) {
				stepState.status = 'failed';
				stepState.detail = error instanceof Error ? error.message : String(error);
			}
			stepState.finishedAt = this.clock();
			if (stepState.status === 'failed') {
				break;
			}
			this.emit();
		}

		for (const step of state.steps) {
			if (step.status === 'pending') {
				step.status = 'skipped';
			}
		}
		state.status = this.cancelled
			? 'cancelled'
			: state.steps.some((step) => step.status === 'failed') ? 'failed' : 'passed';
		state.finishedAt = this.clock();
		this.emit();
		return state;
	}

	private async runStep(script: ScriptDefinition, step: ScriptStep, options: RunOptions): Promise<{ status: StepStatus; detail?: string }> {
		if ('run' in step) {
			const code = await this.executor.runCommand({
				name: `${script.label} › ${step.label}`,
				command: resolvePlaceholders(step.run, options.context),
				env: options.env,
				cwd: options.cwd,
			});
			if (this.cancelled) {
				return { status: 'failed', detail: 'Cancelled.' };
			}
			return code === 0 ? { status: 'passed' } : { status: 'failed', detail: `Exit code ${code}.` };
		}
		const from = path.resolve(options.cwd, resolvePlaceholders(step.copyFile.from, options.context));
		const to = path.resolve(options.cwd, resolvePlaceholders(step.copyFile.to, options.context));
		if (step.copyFile.ifMissing && this.files.exists(to)) {
			return { status: 'skipped', detail: `${path.basename(to)} already exists.` };
		}
		if (!this.files.exists(from)) {
			return { status: 'failed', detail: `${path.basename(from)} not found.` };
		}
		this.files.copy(from, to);
		return { status: 'passed' };
	}

	private emit(): void {
		if (this.current) {
			this.onChange(structuredClone(this.current));
		}
	}
}
