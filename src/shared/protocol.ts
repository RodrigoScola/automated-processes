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
	databases: ViewDatabase[];
	hiddenCount: number;
	showHidden: boolean;
	busy?: string;
	scripts: ViewScript[];
	hasMigrations: boolean;
	run?: ViewRun;
	onBranchChange: BranchChangeMode;
	server: {
		/** A server command is configured. */
		configured: boolean;
		running: boolean;
		/** Running debug sessions that are restarted along with the server. */
		debugSessions: string[];
		onDatabaseChange: 'restart' | 'ask' | 'off';
	};
	canStartDatabase: boolean;
	now: number;
}

export type CommandName =
	| 'newDatabase'
	| 'migrate'
	| 'switchDatabase'
	| 'switchBack'
	| 'removeDatabase'
	| 'cleanUpDatabases'
	| 'runMigrations'
	| 'startDatabase'
	| 'startServer'
	| 'stopServer'
	| 'restartServer'
	| 'refresh'
	| 'openSettings'
	| 'cancelRun'
	| 'showOutput';

export type WebviewMessage =
	| { type: 'ready' }
	| { type: 'command'; command: CommandName; database?: string }
	| { type: 'migrateFrom'; database: string }
	| { type: 'migrateTo'; database: string }
	| { type: 'runScript'; scriptId: string; step?: number }
	| { type: 'setInput'; scriptId: string; name: string; value: string }
	| { type: 'setShowHidden'; value: boolean }
	| { type: 'setOnBranchChange'; value: BranchChangeMode };

export type ExtensionMessage = { type: 'state'; state: ViewState };
