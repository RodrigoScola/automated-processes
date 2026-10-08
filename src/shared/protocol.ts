/** Messages and state shared by the extension and the sidebar webview. No imports on purpose. */

export type BranchChangeMode = 'off' | 'ask' | 'always';
export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
export type RunStatus = 'running' | 'passed' | 'failed' | 'cancelled';

export interface ViewWarning {
	message: string;
	action?: { label: string; command: CommandName };
}

export interface ViewDatabase {
	name: string;
	isMain: boolean;
	isCurrent: boolean;
	isPrevious: boolean;
	branches: string[];
	hidden: boolean;
}

export interface ViewRunStep {
	label: string;
	status: StepStatus;
	detail?: string;
	startedAt?: number;
	finishedAt?: number;
}

export interface ViewRun {
	scriptId: string;
	label: string;
	status: RunStatus;
	startedAt: number;
	finishedAt?: number;
	steps: ViewRunStep[];
}

export interface ViewServer {
	id: string;
	label: string;
	status: 'stopped' | 'running' | 'debugging';
	/** It has a command (the run button). */
	canRun: boolean;
	/** Its launch configuration exists (the debug button). */
	canDebug: boolean;
	debugConfiguration?: string;
	restartOnDatabaseChange: boolean;
}

export interface ViewScript {
	id: string;
	label: string;
	icon: string;
	steps: string[];
	inputs: { name: string; options: string[]; value: string }[];
}

export interface ViewState {
	/** False until a workspace folder and settings are available. */
	hasWorkspace: boolean;
	problems: string[];
	warnings: ViewWarning[];
	branch?: string;
	isMainBranch: boolean;
	current?: {
		name: string;
		isMain: boolean;
		linked: boolean;
		mainName: string;
		previous?: string;
		testName?: string;
		createdAt?: string;
		lastCopiedFrom?: string;
		lastCopiedAt?: string;
	};
	dbStatus: 'unknown' | 'loading' | 'ok' | 'error';
	dbError?: string;
	/** Databases to list: main and current only, unless `showAll`. */
	databases: ViewDatabase[];
	hiddenCount: number;
	showHidden: boolean;
	showAll: boolean;
	/** Databases left out because `showAll` is off. */
	moreCount: number;
	/** Every database on the server. */
	totalDatabases: number;
	busy?: string;
	scripts: ViewScript[];
	hasMigrations: boolean;
	/** Sync Migrations is configured (`migrations.streams`). */
	hasMigrationStreams: boolean;
	run?: ViewRun;
	onBranchChange: BranchChangeMode;
	/** New Database copies the main database's data into the new one. */
	importDataOnCreate: boolean;
	servers: ViewServer[];
	/** Debug sessions not tied to a configured server (also restarted on database change). */
	otherDebugSessions: string[];
	serverRestartMode: 'restart' | 'ask' | 'off';
	canStartDatabase: boolean;
	now: number;
}

export type CommandName =
	| 'newDatabase'
	| 'migrate'
	| 'exportData'
	| 'importData'
	| 'backupDatabase'
	| 'switchDatabase'
	| 'switchBack'
	| 'removeDatabase'
	| 'cleanUpDatabases'
	| 'runMigrations'
	| 'syncMigrations'
	| 'startDatabase'
	| 'connectDatabase'
	| 'startServer'
	| 'stopServer'
	| 'debugServer'
	| 'restartServer'
	| 'refresh'
	| 'openSettings'
	| 'cancelRun'
	| 'showOutput'
	| 'configure';

export type WebviewMessage =
	| { type: 'ready' }
	| { type: 'command'; command: CommandName; database?: string; server?: string; section?: string }
	| { type: 'migrateFrom'; database: string }
	| { type: 'migrateTo'; database: string }
	| { type: 'runScript'; scriptId: string; step?: number }
	| { type: 'setInput'; scriptId: string; name: string; value: string }
	| { type: 'setShowHidden'; value: boolean }
	| { type: 'setShowAll'; value: boolean }
	| { type: 'setOnBranchChange'; value: BranchChangeMode }
	| { type: 'setImportDataOnCreate'; value: boolean }
	| { type: 'setServerRestartMode'; value: 'restart' | 'ask' | 'off' };

export type ExtensionMessage = { type: 'state'; state: ViewState };
