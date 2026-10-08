/** Messages and state shared by the extension and the Configure panel. No imports on purpose. */

export type PanelTab = 'database' | 'servers' | 'scripts';
export type EngineChoice = 'auto' | 'postgres' | 'sqlite';
/** Where the PostgreSQL tools run. */
export type RunsIn = 'local' | 'container' | 'compose';
/** Where saved values apply: this workspace, or every workspace. */
export type Scope = 'local' | 'global';

export interface PanelDatabase {
	engine: EngineChoice;
	/** Engine the current URL needs, when the URL could be read. */
	detectedEngine?: 'postgres' | 'sqlite';
	/** The URL comes from the env file, or was entered here (kept in VS Code's secret storage). */
	source: 'envFile' | 'url';
	envFile: string;
	urlVariable: string;
	/** Entered URL with the password hidden. */
	urlPreview?: string;
	runsIn: RunsIn;
	dockerName: string;
	sqliteFolder: string;
	mainBranches: string[];
}

/** What the Database tab sends on Save. `url` only when a new one was typed. */
export interface PanelDatabaseForm {
	engine: EngineChoice;
	source: 'envFile' | 'url';
	envFile: string;
	urlVariable: string;
	url?: string;
	runsIn: RunsIn;
	dockerName: string;
	sqliteFolder: string;
	mainBranches: string[];
}

export interface PanelServer {
	id: string;
	label: string;
	command: string;
	debugConfiguration: string;
	restartOnDatabaseChange: boolean;
	/** Folder the command runs in, relative to the workspace; empty = the workspace. */
	cwd: string;
	runOnStartup: boolean;
	/** `launch`: only in launch.json; `both`: configured and in launch.json. */
	source: 'config' | 'launch' | 'both';
}

export interface PanelServerForm {
	label: string;
	command: string;
	debugConfiguration: string;
	restartOnDatabaseChange: boolean;
	cwd: string;
	runOnStartup: boolean;
}

export type PanelStep =
	| { label: string; run: string }
	| { label: string; copyFile: { from: string; to: string; ifMissing: boolean } };

export interface PanelScript {
	id: string;
	label: string;
	icon: string;
	cwd?: string;
	/** When it runs by itself; absent = only from its button. */
	runOn?: { startup?: boolean; branchChange?: boolean; fileSave?: boolean; fileSavePatterns?: string[]; gitUpdate?: boolean; gitUpdatePatterns?: string[] };
	env: Record<string, string>;
	inputs: Record<string, { options: string[]; default: string }>;
	steps: PanelStep[];
}

export interface PanelStream {
	name: string;
	versionQuery: string;
	versionsPath: string;
	downgradeCommand: string;
	cwd: string;
}

export interface PanelMigrations {
	command: string;
	cwd: string;
	onBranchChange: 'off' | 'ask' | 'always';
	afterCopy: boolean;
	streams: PanelStream[];
}

/** Something "Add defaults" found in the project. */
export interface PanelSuggestion {
	id: string;
	kind: 'server' | 'script' | 'migrations' | 'stream';
	label: string;
	detail: string;
	/** Something with the same name or command is already there. */
	exists: boolean;
}

export interface PanelState {
	database: PanelDatabase;
	servers: PanelServer[];
	/** launch.json configurations, and whether a server already debugs each one. */
	launchConfigurations: { name: string; added: boolean }[];
	includeLaunchConfigurations: boolean;
	scripts: PanelScript[];
	migrations: PanelMigrations;
	/** Where each tab's saved values come from (this workspace wins), or undefined for settings.json. */
	stored: Record<PanelTab, Scope | undefined>;
	problems: string[];
	/** Every codicon name, for the icon picker. */
	icons: string[];
}

export interface PanelNotice {
	kind: 'ok' | 'error';
	message: string;
	/** The tab it belongs to. */
	tab: PanelTab;
	/** Shown next to the Migrations form rather than at the top of the tab. */
	area?: 'migrations';
}

export type PanelMessage =
	| { type: 'ready' }
	| { type: 'saveDatabase'; form: PanelDatabaseForm; scope: Scope }
	| { type: 'testConnection' }
	| { type: 'saveServer'; originalId?: string; server: PanelServerForm; scope: Scope }
	| { type: 'deleteServer'; id: string; scope: Scope }
	| { type: 'addLaunch'; name: string; scope: Scope }
	| { type: 'setIncludeLaunch'; value: boolean; scope: Scope }
	| { type: 'saveScript'; originalId?: string; script: PanelScript; scope: Scope }
	| { type: 'deleteScript'; id: string; scope: Scope }
	| { type: 'moveScript'; id: string; delta: -1 | 1; scope: Scope }
	| { type: 'saveMigrations'; migrations: PanelMigrations; scope: Scope }
	| { type: 'removeMigrations'; scope: Scope }
	| { type: 'detect'; tab: 'servers' | 'scripts' }
	| { type: 'addSuggestions'; ids: string[]; tab: 'servers' | 'scripts'; scope: Scope }
	| { type: 'reset'; tab: PanelTab }
	| { type: 'open'; target: 'launchJson' | 'settings' };

export type PanelHostMessage =
	| { type: 'state'; state: PanelState }
	| { type: 'show'; tab: PanelTab }
	| { type: 'suggestions'; tab: 'servers' | 'scripts'; suggestions: PanelSuggestion[] }
	/** Result of the last action; `saved` closes the open form. */
	| { type: 'notice'; notice: PanelNotice; saved?: boolean };
