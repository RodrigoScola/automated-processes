/** Interfaces the controller needs from the outside world (VS Code, git). */

import { EnvMap } from './envFile';

export interface PickItem<T> {
	label: string;
	description?: string;
	detail?: string;
	value: T;
	picked?: boolean;
}

export interface Ui {
	info(message: string, ...actions: string[]): Promise<string | undefined>;
	warn(message: string, ...actions: string[]): Promise<string | undefined>;
	error(message: string, ...actions: string[]): Promise<string | undefined>;
	/** Modal dialog with one confirm button (plus Cancel). */
	confirm(message: string, detail: string, confirmLabel: string): Promise<boolean>;
	/** Modal dialog with several buttons (plus Cancel → undefined). */
	choose(message: string, detail: string, options: string[]): Promise<string | undefined>;
	pickOne<T>(items: PickItem<T>[], title: string, placeholder?: string): Promise<T | undefined>;
	pickMany<T>(items: PickItem<T>[], title: string, placeholder?: string): Promise<T[] | undefined>;
	input(title: string, prompt: string, value: string, validate: (value: string) => string | undefined): Promise<string | undefined>;
	withProgress<T>(title: string, task: () => Promise<T>): Promise<T>;
}

export interface GitPort {
	currentBranch(): string | undefined;
	/** Local branch name → tip commit. */
	localBranches(): Promise<Map<string, string>>;
	/** Local branches whose tip is contained in `branch`. */
	mergedInto(branch: string): Promise<Set<string>>;
}

/** Applies extra variables to new terminals and debug sessions. `undefined` clears them. */
export interface EnvironmentSink {
	apply(additions: EnvMap | undefined, options: { terminals: boolean; description: string }): void;
}

export interface SettingsWriter {
	update(key: string, value: unknown): Promise<void>;
	open(): void;
}
