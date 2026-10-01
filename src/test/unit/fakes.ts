import { Config, ConfigResult, DEFAULT_CONFIG } from '../../core/config';
import { Controller } from '../../core/controller';
import { EnvMap } from '../../core/envFile';
import { ProjectEnv } from '../../core/environment';
import { EnvironmentSink, GitPort, PickItem, ServerControl, SettingsWriter, Ui } from '../../core/ports';
import { ClientSettings, DatabaseConnection, DatabaseEngine } from '../../core/postgres';
import { CommandExecutor, CommandRequest, FileOps, ScriptRunner } from '../../core/scriptRunner';
import { BranchStore, MemoryKeyValueStore } from '../../core/store';

export class FakeUi implements Ui {
	readonly log: { kind: string; message: string; detail?: string; actions?: string[] }[] = [];
	infoAnswer: (message: string, actions: string[]) => string | undefined = () => undefined;
	confirmAnswer: (message: string) => boolean = () => true;
	chooseAnswer: (message: string, options: string[]) => string | undefined = (_message, options) => options[0];
	pickOneAnswer: <T>(items: PickItem<T>[], title: string) => T | undefined = (items) => items.find((item) => item.picked)?.value ?? items[0]?.value;
	pickManyAnswer: <T>(items: PickItem<T>[]) => T[] | undefined = (items) => items.filter((item) => item.picked).map((item) => item.value);
	inputAnswer: (value: string, validate: (value: string) => string | undefined) => string | undefined = (value) => value;
	lastPickItems: PickItem<unknown>[] = [];
	lastInputValidation: ((value: string) => string | undefined) | undefined;

	async info(message: string, ...actions: string[]) {
		this.log.push({ kind: 'info', message, actions });
		return this.infoAnswer(message, actions);
	}
	async warn(message: string, ...actions: string[]) {
		this.log.push({ kind: 'warn', message, actions });
		return undefined;
	}
	async error(message: string, ...actions: string[]) {
		this.log.push({ kind: 'error', message, actions });
		return undefined;
	}
	async confirm(message: string, detail: string, confirmLabel: string) {
		this.log.push({ kind: 'confirm', message, detail, actions: [confirmLabel] });
		return this.confirmAnswer(message);
	}
	async choose(message: string, detail: string, options: string[]) {
		this.log.push({ kind: 'choose', message, detail, actions: options });
		return this.chooseAnswer(message, options);
	}
	async pickOne<T>(items: PickItem<T>[], title: string) {
		this.log.push({ kind: 'pickOne', message: title });
		this.lastPickItems = items;
		return this.pickOneAnswer(items, title);
	}
	async pickMany<T>(items: PickItem<T>[], title: string) {
		this.log.push({ kind: 'pickMany', message: title });
		this.lastPickItems = items;
		return this.pickManyAnswer(items);
	}
	async input(title: string, prompt: string, value: string, validate: (value: string) => string | undefined) {
		this.log.push({ kind: 'input', message: title, detail: value });
		this.lastInputValidation = validate;
		return this.inputAnswer(value, validate);
	}
	async withProgress<T>(_title: string, task: () => Promise<T>) {
		return task();
	}

	messages(kind: string): string[] {
		return this.log.filter((entry) => entry.kind === kind).map((entry) => entry.message);
	}
}

export class FakeGit implements GitPort {
	branch: string | undefined = 'feature/login';
	branches = new Map<string, string>([['main', 'c-main'], ['feature/login', 'c-login']]);
	merged = new Set<string>();

	currentBranch() {
		return this.branch;
	}
	async localBranches() {
		return new Map(this.branches);
	}
	async mergedInto() {
		return new Set(this.merged);
	}

	/** Files per ref; the key '' is the working tree. */
	readonly trees = new Map<string, Map<string, string>>([['', new Map()]]);
	/** Text → branches whose history added it. */
	readonly origins = new Map<string, string[]>();
	readonly worktreeLog: string[] = [];

	setFile(ref: string, file: string, text: string) {
		if (!this.trees.has(ref)) {
			this.trees.set(ref, new Map());
		}
		this.trees.get(ref)!.set(file, text);
	}
	async listFiles(dir: string, ref = '') {
		return [...(this.trees.get(ref)?.keys() ?? [])].filter((file) => file.startsWith(`${dir}/`));
	}
	async readFile(file: string, ref = '') {
		const text = this.trees.get(ref)?.get(file);
		if (text === undefined) {
			throw new Error(`no ${file} at ${ref || 'working tree'}`);
		}
		return text;
	}
	async branchesContaining(text: string) {
		return this.origins.get(text) ?? [];
	}
	async addWorktree(ref: string) {
		this.worktreeLog.push(`add ${ref}`);
		return `/tmp/wt-${ref}`;
	}
	async removeWorktree(folder: string) {
		this.worktreeLog.push(`remove ${folder}`);
	}
}

export class FakeEngine implements DatabaseEngine {
	readonly databases = new Set<string>();
	readonly settings = new Map<string, string[]>();
	readonly sessions = new Map<string, DatabaseConnection[]>();
	readonly calls: string[] = [];
	/** `${database}|${sql}` → rows. */
	readonly results = new Map<string, string[][]>();
	failListing: Error | undefined;
	failDumpRestore: Error | undefined;

	constructor(...names: string[]) {
		names.forEach((name) => this.databases.add(name));
	}

	async query(sql: string, database = 'postgres') {
		this.calls.push(`query ${database}: ${sql}`);
		return this.results.get(`${database}|${sql}`) ?? [];
	}

	async listDatabases() {
		this.calls.push('list');
		if (this.failListing) {
			throw this.failListing;
		}
		return [...this.databases].sort();
	}
	async connections(database: string) {
		return this.sessions.get(database) ?? [];
	}
	async terminateConnections(database: string) {
		this.calls.push(`terminate ${database}`);
		const count = this.sessions.get(database)?.length ?? 0;
		this.sessions.delete(database);
		return count;
	}
	async createEmpty(database: string) {
		this.calls.push(`createEmpty ${database}`);
		this.assertMissing(database);
		this.databases.add(database);
	}
	async createFromTemplate(database: string, template: string) {
		this.calls.push(`template ${template} -> ${database}`);
		if ((this.sessions.get(template)?.length ?? 0) > 0) {
			throw new Error(`psql failed: source database "${template}" is being accessed by other users`);
		}
		this.assertMissing(database);
		this.databases.add(database);
	}
	async dumpRestore(source: string, target: string) {
		this.calls.push(`dump ${source} -> ${target}`);
		if (this.failDumpRestore) {
			throw this.failDumpRestore;
		}
	}
	async copySettings(source: string, target: string) {
		this.calls.push(`settings ${source} -> ${target}`);
		this.settings.set(target, [...(this.settings.get(source) ?? [])]);
	}
	async drop(database: string) {
		this.calls.push(`drop ${database}`);
		this.databases.delete(database);
	}

	private assertMissing(database: string) {
		if (this.databases.has(database)) {
			throw new Error(`database "${database}" already exists`);
		}
	}
}

export class FakeExecutor implements CommandExecutor {
	readonly requests: CommandRequest[] = [];
	exitCode: (request: CommandRequest) => number = () => 0;
	cancelled = false;

	async runCommand(request: CommandRequest) {
		this.requests.push(request);
		return this.exitCode(request);
	}
	cancel() {
		this.cancelled = true;
	}
}

export class FakeFiles implements FileOps {
	readonly files = new Set<string>();
	readonly copies: [string, string][] = [];
	exists(file: string) {
		return this.files.has(file);
	}
	copy(from: string, to: string) {
		this.copies.push([from, to]);
		this.files.add(to);
	}
}

export class FakeEnvSink implements EnvironmentSink {
	last: { additions: EnvMap | undefined; terminals: boolean } | undefined;
	apply(additions: EnvMap | undefined, options: { terminals: boolean }) {
		this.last = { additions, terminals: options.terminals };
	}
}

export class FakeServer implements ServerControl {
	running = false;
	sessions: string[] = [];
	readonly events: string[] = [];
	lastEnv: EnvMap | undefined;

	isServerRunning() {
		return this.running;
	}
	runningDebugSessions() {
		return [...this.sessions];
	}
	async startServer(command: string, env: EnvMap) {
		this.events.push(`${this.running ? 'restart' : 'start'} ${command} @ ${env.DATABASE_URL?.split('/').pop()}`);
		this.running = true;
		this.lastEnv = env;
	}
	stopServer() {
		this.events.push('stop');
		this.running = false;
	}
	async restartDebugSessions() {
		this.sessions.forEach((name) => this.events.push(`debug ${name}`));
		return [...this.sessions];
	}
}

export class FakeSettings implements SettingsWriter {
	readonly updates: [string, unknown][] = [];
	opened = 0;
	async update(key: string, value: unknown) {
		this.updates.push([key, value]);
	}
	open() {
		this.opened++;
	}
}

type ConfigOverrides = Partial<Omit<Config, 'database' | 'migrations' | 'testDatabase'>> & {
	database?: Partial<Config['database']>;
	migrations?: Partial<Config['migrations']>;
	testDatabase?: Partial<Config['testDatabase']>;
};

export function testConfig(overrides: ConfigOverrides = {}): Config {
	return {
		...DEFAULT_CONFIG,
		...overrides,
		database: { ...DEFAULT_CONFIG.database, mainBranches: ['main'], ...overrides.database },
		testDatabase: { ...DEFAULT_CONFIG.testDatabase, ...overrides.testDatabase },
		migrations: { ...DEFAULT_CONFIG.migrations, ...overrides.migrations },
		scripts: overrides.scripts ?? [],
	};
}

export const MAIN_URL = 'postgresql+asyncpg://app:secret@127.0.0.1:5433/app';

export interface Harness {
	controller: Controller;
	ui: FakeUi;
	git: FakeGit;
	engine: FakeEngine;
	executor: FakeExecutor;
	store: BranchStore;
	prefs: MemoryKeyValueStore;
	envSink: FakeEnvSink;
	server: FakeServer;
	settings: FakeSettings;
	engineSettings: ClientSettings[];
	config: Config;
	env: ProjectEnv;
	changes: number;
}

export function harness(options: { config?: Config; env?: Partial<ProjectEnv>; databases?: string[]; root?: string | undefined; problems?: string[] } = {}): Harness {
	const kv = new MemoryKeyValueStore();
	const h: Harness = {
		controller: undefined as unknown as Controller,
		ui: new FakeUi(),
		git: new FakeGit(),
		engine: new FakeEngine(...(options.databases ?? ['postgres', 'app'])),
		executor: new FakeExecutor(),
		store: new BranchStore(kv, () => new Date('2026-10-01T12:00:00Z')),
		prefs: new MemoryKeyValueStore(),
		envSink: new FakeEnvSink(),
		server: new FakeServer(),
		settings: new FakeSettings(),
		engineSettings: [],
		config: options.config ?? testConfig({ migrations: { command: 'migrate up' } }),
		env: { main: { DATABASE_URL: MAIN_URL, OTHER: 'x' }, test: {}, ...options.env },
		changes: 0,
	};
	if (!options.env?.test) {
		h.env.test = h.env.main;
	}
	const root = 'root' in options ? options.root : '/repo';
	h.controller = new Controller({
		ui: h.ui,
		git: h.git,
		store: h.store,
		prefs: h.prefs,
		settings: h.settings,
		envSink: h.envSink,
		server: h.server,
		scripts: new ScriptRunner(h.executor, () => undefined, new FakeFiles(), () => 1000),
		readConfig: (): ConfigResult => ({ config: h.config, problems: options.problems ?? [] }),
		root: () => root,
		readEnv: () => h.env,
		createEngine: (settings) => {
			h.engineSettings.push(settings);
			return h.engine;
		},
		processEnv: { PATH: '/bin' },
		onDidChange: () => h.changes++,
		now: () => Date.parse('2026-10-01T12:00:00Z'),
	});
	return h;
}
