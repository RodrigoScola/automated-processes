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
	/** Commit HEAD points at. */
	currentCommit(): string | undefined;
	/** Files (repo-relative, `/`) that differ between two commits. */
	changedFiles(from: string, to: string): Promise<string[]>;
	/** Local branch name → tip commit. */
	localBranches(): Promise<Map<string, string>>;
	/** Local branches whose tip is contained in `branch`. */
	mergedInto(branch: string): Promise<Set<string>>;
	/** File paths (relative to the repo root) under `dir`, in the working tree or at `ref`. */
	listFiles(dir: string, ref?: string): Promise<string[]>;
	/** A file's text, in the working tree or at `ref`. */
	readFile(file: string, ref?: string): Promise<string>;
	/** Branches (local first, then remote) whose history added `text` somewhere under `dir`. */
	branchesContaining(text: string, dir: string): Promise<string[]>;
	/** Checks `ref` out into a temporary folder and returns its path. */
	addWorktree(ref: string): Promise<string>;
	removeWorktree(path: string): Promise<void>;
}

/** Applies extra variables to new terminals and debug sessions. `undefined` clears them. */
export interface EnvironmentSink {
	apply(additions: EnvMap | undefined, options: { terminals: boolean; debugSessions: boolean; description: string }): void;
}

/** The app's servers (each in a terminal the extension owns) and running debug sessions. */
export interface ServerControl {
	/** Ids of servers whose terminal is running. */
	runningServers(): string[];
	/** Starts (or restarts) a server's terminal with this environment. */
	startServer(id: string, label: string, command: string, env: EnvMap, cwd: string): Promise<void>;
	stopServer(id: string): void;
	/** Names of running launch-type debug sessions. */
	runningDebugSessions(): string[];
	/** Restarts running debug sessions (except those named in `skip`) with the new environment. */
	restartDebugSessions(skip: string[]): Promise<string[]>;
	/** Names of the launch configurations in the workspace's launch.json. */
	launchConfigurations(): string[];
	/** Starts the named launch configuration; false when VS Code couldn't start it. */
	startDebugging(name: string): Promise<boolean>;
	stopDebugging(name: string): Promise<void>;
}

export interface SettingsWriter {
	update(key: string, value: unknown): Promise<void>;
	open(): void;
}
