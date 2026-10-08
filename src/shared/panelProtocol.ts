/** Messages and state shared by the extension and the Configure panel. No imports on purpose. */

export type PanelTab = 'database' | 'servers' | 'scripts';
export type EngineChoice = 'auto' | 'postgres' | 'sqlite';
/** Where the PostgreSQL tools run. */
export type RunsIn = 'local' | 'container' | 'compose';

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
	/** `launch`: only in launch.json; `both`: configured and in launch.json. */
	source: 'config' | 'launch' | 'both';
}

export type PanelStep =
	| { label: string; run: string }
	| { label: string; copyFile: { from: string; to: string; ifMissing: boolean } };

export interface PanelScript {
	id: string;
	label: string;
	icon: string;
	env: Record<string, string>;
	inputs: Record<string, { options: string[]; default: string }>;
	steps: PanelStep[];
}

export interface PanelState {
	database: PanelDatabase;
	servers: PanelServer[];
	launchConfigurations: string[];
	includeLaunchConfigurations: boolean;
	scripts: PanelScript[];
	/** Which tabs have values stored in the extension (they override settings.json). */
	stored: Record<PanelTab, boolean>;
	problems: string[];
}

export interface PanelNotice {
	kind: 'ok' | 'error';
	message: string;
	/** The tab it belongs to. */
	tab: PanelTab;
}

export type PanelMessage =
	| { type: 'ready' }
	| { type: 'saveDatabase'; form: PanelDatabaseForm }
	| { type: 'testConnection' }
	| { type: 'saveServer'; originalId?: string; server: { label: string; command: string; debugConfiguration: string; restartOnDatabaseChange: boolean } }
	| { type: 'deleteServer'; id: string }
	| { type: 'setIncludeLaunch'; value: boolean }
	| { type: 'saveScript'; originalId?: string; script: PanelScript }
	| { type: 'deleteScript'; id: string }
	| { type: 'moveScript'; id: string; delta: -1 | 1 }
	| { type: 'reset'; tab: PanelTab }
	| { type: 'open'; target: 'launchJson' | 'settings' };

export type PanelHostMessage =
	| { type: 'state'; state: PanelState }
	| { type: 'show'; tab: PanelTab }
	/** Result of the last action; `saved` closes the open form. */
	| { type: 'notice'; notice: PanelNotice; saved?: boolean };
