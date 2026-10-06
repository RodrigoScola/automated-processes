import * as path from 'path';
import { CurrentDatabase, databasesFreeAfterUnlink, findFinishedLinks, isMainBranch, resolveCurrent } from './branches';
import { BranchChangeMode, Config, ConfigResult, MigrationStream, ScriptDefinition, ServerDefinition, ServerRestartMode } from './config';
import { buildGraph, MigrationGraph, planRevert } from './migrationSync';
import { parseDbUrl } from './dbUrl';
import { EnvMap } from './envFile';
import {
	buildCommandEnv,
	buildEnvAdditions,
	MainDatabase,
	mainDatabase,
	placeholderContext,
	ProjectEnv,
	testDatabaseFor,
} from './environment';
import { matchesAnyGlob, matchesGlob } from './glob';
import { suggestDatabaseName, testDatabaseName, validateDatabaseName } from './names';
import { EnvironmentSink, GitPort, PickItem, ServerControl, SettingsWriter, Ui } from './ports';
import { ClientSettings, DatabaseEngine, isContainerStopped, isDockerDown, isTemplateInUse, isToolMissing } from './postgres';
import { RunState, ScriptRunner } from './scriptRunner';
import { BranchStore, KeyValueStore } from './store';
import { ViewServer, ViewState, ViewWarning } from '../shared/protocol';

/** An error whose message is shown to the user as is. */
export class UserError extends Error {}

export interface ControllerDeps {
	ui: Ui;
	git: GitPort;
	store: BranchStore;
	/** Small per-workspace preferences (script inputs, show hidden). */
	prefs: KeyValueStore;
	settings: SettingsWriter;
	envSink: EnvironmentSink;
	scripts: ScriptRunner;
	readConfig(): ConfigResult;
	/** Workspace folder, or undefined when none is open. */
	root(): string | undefined;
	readEnv(root: string, config: Config): ProjectEnv;
	createEngine(settings: ClientSettings): DatabaseEngine;
	server: ServerControl;
	processEnv: Record<string, string | undefined>;
	onDidChange(): void;
	now?: () => number;
}

interface Ready {
	config: Config;
	root: string;
	env: ProjectEnv;
	main: MainDatabase;
	engine: DatabaseEngine;
	branch: string | undefined;
}

const MAINTENANCE_DATABASES = ['postgres', 'template0', 'template1'];
const PREF_INPUTS = 'automatedProcesses.inputs';
const PREF_SHOW_HIDDEN = 'automatedProcesses.showHidden';
const MIGRATIONS_SCRIPT_ID = '__migrations';

export class Controller {
	private lastBranch: string | undefined;
	private lastCommit: string | undefined;
	private started = false;
	private databases: string[] = [];
	private dbStatus: ViewState['dbStatus'] = 'unknown';
	private dbError: string | undefined;
	/** Why a Docker database is unreachable, when that's known. */
	private dockerProblem: 'dockerDown' | 'containerStopped' | undefined;
	private busy: string | undefined;
	private problems: string[] = [];
	private current: CurrentDatabase | undefined;
	private mainName: string | undefined;
	private checkingBranches = false;
	/** The current database changed; running servers should restart once the action finishes. */
	private restartPending = false;
	private initialized = false;

	constructor(private readonly deps: ControllerDeps) {}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	async start(): Promise<void> {
		this.lastBranch = this.deps.git.currentBranch();
		this.lastCommit = this.deps.git.currentCommit();
		this.started = true;
		await this.refresh();
		this.initialized = true;
		if (this.dockerProblem === 'containerStopped') {
			await this.startDatabase();
		}
		await this.checkFinishedBranches();
	}

	/**
	 * Called when git state changes. Reacts to a branch switch, and to new commits on the same
	 * branch (pull, merge, rebase) for `onGitUpdate`.
	 */
	async onGitStateChanged(): Promise<void> {
		if (!this.started) {
			return;
		}
		const branch = this.deps.git.currentBranch();
		const commit = this.deps.git.currentCommit();
		const previousCommit = this.lastCommit;
		this.lastCommit = commit;
		if (branch === this.lastBranch) {
			if (branch && previousCommit && commit && previousCommit !== commit) {
				await this.afterBranchUpdated(branch, previousCommit, commit);
			}
			return;
		}
		const previousBranch = this.lastBranch;
		this.lastBranch = branch;
		await this.refresh();
		if (previousBranch !== undefined && branch !== undefined) {
			// When migrations run by themselves, restart after them so the server sees the new schema.
			if (!this.willMigrateAutomatically(branch)) {
				await this.restartServersIfPending();
			}
			await this.afterBranchSwitch(branch);
		}
		await this.restartServersIfPending();
	}

	/** Re-reads settings, env files and the database list, then updates terminals and the view. */
	async refresh(): Promise<void> {
		const root = this.deps.root();
		const { config, problems } = this.deps.readConfig();
		this.problems = [...problems];
		this.current = undefined;
		this.mainName = undefined;
		if (!root) {
			this.deps.envSink.apply(undefined, { terminals: false, description: '' });
			this.changed();
			return;
		}

		let env: ProjectEnv;
		let main: MainDatabase;
		try {
			env = this.deps.readEnv(root, config);
			main = mainDatabase(config, env);
		} catch (error) {
			this.problems.push(messageOf(error));
			this.databases = [];
			this.dbStatus = 'unknown';
			this.deps.envSink.apply(undefined, { terminals: false, description: '' });
			this.changed();
			return;
		}

		this.mainName = main.name;
		const branch = this.deps.git.currentBranch();
		const data = this.deps.store.data();
		this.current = resolveCurrent(branch, data.links, main.name);
		const switched = await this.deps.store.setCurrent(this.current.database);
		if (switched && this.initialized) {
			this.restartPending = true;
		}

		this.deps.envSink.apply(
			buildEnvAdditions({
				processEnv: this.deps.processEnv,
				config,
				env,
				database: this.current.database,
				isMain: this.current.isMain,
				branch,
			}),
			{ terminals: config.applyToTerminals, description: `Database: ${this.current.database}` },
		);

		this.dbStatus = 'loading';
		this.changed();
		try {
			this.databases = await this.engineFor(config, root, main).listDatabases();
			this.dbStatus = 'ok';
			this.dbError = undefined;
			this.dockerProblem = undefined;
		} catch (error) {
			this.databases = [];
			this.dbStatus = 'error';
			this.dockerProblem = !dockerTarget(config) ? undefined
				: isDockerDown(error) ? 'dockerDown'
					: isContainerStopped(error) ? 'containerStopped' : undefined;
			this.dbError = isToolMissing(error) && !dockerTarget(config)
				? `${messageOf(error)} If PostgreSQL runs in Docker, set automatedProcesses.database.dockerContainer (e.g. "my-db-1", as in \`docker exec -it my-db-1 psql\`) and the tools run inside it.`
				: messageOf(error);
		}
		this.changed();
	}

	// ── View state ────────────────────────────────────────────────────────────

	snapshot(): ViewState {
		const { config } = this.deps.readConfig();
		const root = this.deps.root();
		const data = this.deps.store.data();
		const branch = this.deps.git.currentBranch();
		const showHidden = this.deps.prefs.get<boolean>(PREF_SHOW_HIDDEN) ?? false;
		const mainName = this.mainName;
		const current = this.current;

		const linkedBranches = new Map<string, string[]>();
		for (const [linkBranch, link] of Object.entries(data.links)) {
			linkedBranches.set(link.database, [...(linkedBranches.get(link.database) ?? []), linkBranch]);
		}
		const all = this.databases.map((name) => ({
			name,
			isMain: name === mainName,
			isCurrent: name === current?.database,
			isPrevious: name === data.previous,
			branches: linkedBranches.get(name) ?? [],
			hidden: name !== mainName && name !== current?.database && matchesAnyGlob(name, config.database.hidePatterns),
		}));
		// Main first, then the current one, then the rest by name.
		all.sort((a, b) => Number(b.isMain) - Number(a.isMain)
			|| Number(b.isCurrent) - Number(a.isCurrent)
			|| a.name.localeCompare(b.name));

		let testName: string | undefined;
		if (current && root) {
			try {
				testName = testDatabaseFor(config, this.deps.readEnv(root, config), current.database, current.isMain)?.name;
			} catch {
				testName = undefined;
			}
		}
		const meta = current ? data.meta[current.database] ?? {} : {};
		const inputs = this.deps.prefs.get<Record<string, Record<string, string>>>(PREF_INPUTS) ?? {};

		return {
			hasWorkspace: root !== undefined,
			problems: [...this.problems],
			warnings: this.warnings(config, branch),
			branch,
			isMainBranch: isMainBranch(branch, config.database.mainBranches),
			current: current && mainName
				? {
					name: current.database,
					isMain: current.isMain,
					linked: current.linked,
					mainName,
					previous: data.previous,
					testName,
					createdAt: meta.createdAt,
					lastCopiedFrom: meta.lastCopiedFrom,
					lastCopiedAt: meta.lastCopiedAt,
				}
				: undefined,
			dbStatus: this.dbStatus,
			dbError: this.dbError,
			databases: showHidden ? all : all.filter((db) => !db.hidden),
			hiddenCount: all.filter((db) => db.hidden).length,
			showHidden,
			busy: this.busy,
			scripts: config.scripts.map((script) => ({
				id: script.id,
				label: script.label,
				icon: script.icon,
				steps: script.steps.map((step) => step.label),
				inputs: Object.entries(script.inputs).map(([name, input]) => {
					const chosen = inputs[script.id]?.[name];
					return { name, options: input.options, value: chosen && input.options.includes(chosen) ? chosen : input.default };
				}),
			})),
			hasMigrations: config.migrations.command !== '',
			hasMigrationStreams: config.migrations.streams.length > 0,
			run: this.deps.scripts.lastRun,
			onBranchChange: config.migrations.onBranchChange,
			importDataOnCreate: config.database.importDataOnCreate,
			...this.serverView(config),
			gitUpdate: ((script) => (script ? { label: script.label, mode: config.onGitUpdate.mode } : undefined))(
				config.scripts.find((item) => item.id === config.onGitUpdate.script),
			),
			canStartDatabase: dockerTarget(config) !== undefined,
			now: this.now(),
		};
	}

	private serverView(config: Config): Pick<ViewState, 'servers' | 'otherDebugSessions' | 'serverRestartMode'> {
		const terminals = new Set(this.deps.server.runningServers());
		const sessions = this.deps.server.runningDebugSessions();
		const launch = new Set(this.deps.server.launchConfigurations());
		const servers: ViewServer[] = config.servers.map((server) => ({
			id: server.id,
			label: server.label,
			status: server.debugConfiguration && sessions.includes(server.debugConfiguration)
				? 'debugging'
				: terminals.has(server.id) ? 'running' : 'stopped',
			canRun: server.command !== '',
			canDebug: server.debugConfiguration !== '' && launch.has(server.debugConfiguration),
			debugConfiguration: server.debugConfiguration || undefined,
			restartOnDatabaseChange: server.restartOnDatabaseChange,
		}));
		const owned = new Set(config.servers.map((server) => server.debugConfiguration).filter(Boolean));
		return {
			servers,
			otherDebugSessions: sessions.filter((name) => !owned.has(name)),
			serverRestartMode: config.server.onDatabaseChange,
		};
	}

	private warnings(config: Config, branch: string | undefined): ViewWarning[] {
		const warnings: ViewWarning[] = [];
		if (this.dbStatus === 'error') {
			const docker = dockerTarget(config);
			if (docker && this.dockerProblem === 'dockerDown') {
				warnings.push({
					message: 'Docker isn\'t running. Start Docker, then retry.',
					action: { label: 'Retry', command: 'connectDatabase' },
				});
			} else if (docker && this.dockerProblem === 'containerStopped') {
				warnings.push({
					message: `The "${docker.name}" container isn't running.`,
					action: { label: 'Retry', command: 'connectDatabase' },
				});
			} else {
				warnings.push({
					message: docker
						? `Can't reach the database. Is the "${docker.name}" container running?`
						: 'Can\'t reach the database server.',
					action: docker ? { label: 'Start Database', command: 'startDatabase' } : undefined,
				});
			}
		}
		if (this.current && !this.current.linked && branch && !isMainBranch(branch, config.database.mainBranches)) {
			warnings.push({
				message: `"${branch}" has no database of its own and is using the main database.`,
				action: { label: 'New Database', command: 'newDatabase' },
			});
		}
		if (this.started && branch === undefined && this.deps.root()) {
			warnings.push({ message: 'No git branch (detached HEAD or no repository). Using the main database.' });
		}
		return warnings;
	}

	// ── Database commands ─────────────────────────────────────────────────────

	async newDatabase(): Promise<void> {
		await this.guard('Creating database', async () => {
			const ready = this.ready();
			const branch = this.requireBranch(ready);
			if (isMainBranch(branch, ready.config.database.mainBranches)) {
				const go = await this.deps.ui.confirm(
					`"${branch}" is a main branch.`,
					`It normally uses the main database (${ready.main.name}). Create a separate database for it anyway?`,
					'Create Anyway',
				);
				if (!go) {
					return;
				}
			}
			const importData = ready.config.database.importDataOnCreate;
			const existing = new Set(await ready.engine.listDatabases());
			const name = await this.deps.ui.input(
				'New Database',
				importData
					? `A copy of ${ready.main.name} (schema and data) for "${branch}". Migrations run on it afterwards.`
					: `An empty database for "${branch}". Migrations run on it afterwards.`,
				uniqueName(suggestDatabaseName(ready.config.database.newNamePattern, ready.main.name, branch), existing),
				(value) => validateDatabaseName(value) ?? (existing.has(value) ? `"${value}" already exists.` : undefined),
			);
			if (!name) {
				return;
			}
			if (importData) {
				const copied = await this.copyDatabase(ready, ready.main.name, name, false);
				if (!copied) {
					return;
				}
			} else {
				await this.deps.ui.withProgress(`Creating ${name}`, () => ready.engine.createEmpty(name));
			}
			const tips = await this.deps.git.localBranches().catch(() => new Map<string, string>());
			await this.deps.store.link(branch, name, tips.get(branch));
			const stamp = new Date(this.now()).toISOString();
			await this.deps.store.updateMeta(name, importData
				? { createdAt: stamp, lastCopiedFrom: ready.main.name, lastCopiedAt: stamp }
				: { createdAt: stamp });
			await this.refresh();
			if (ready.config.migrations.command) {
				await this.runMigrationsOn(name, false, true);
			}
			void this.deps.ui.info(`Created ${name} for "${branch}" and switched to it.`);
		});
	}

	async migrate(options: { source?: string; target?: string } = {}): Promise<void> {
		await this.guard('Copying database', async () => {
			const ready = this.ready();
			const databases = (await ready.engine.listDatabases()).filter((db) => !MAINTENANCE_DATABASES.includes(db));
			const current = this.current?.database ?? ready.main.name;

			const sources = databases.filter((db) => db !== options.target);
			const source = options.source ?? await this.deps.ui.pickOne(
				this.databaseItems(sources, ready, options.target === ready.main.name ? undefined : ready.main.name),
				'Export Data: copy FROM',
				'Database to copy from (default: main)',
			);
			if (!source) {
				return;
			}
			const targets = databases.filter((db) => db !== source);
			const target = options.target ?? await this.deps.ui.pickOne(
				this.databaseItems(targets, ready, current === source ? undefined : current),
				`Export Data: copy ${source} INTO`,
				'Database to replace (default: current)',
			);
			if (!target) {
				return;
			}
			if (target === source) {
				throw new UserError('Pick two different databases.');
			}
			const replace = await this.deps.ui.confirm(
				`Replace ${target} with a copy of ${source}?`,
				`Everything in ${target} is deleted first.`,
				'Replace',
			);
			if (!replace) {
				return;
			}
			if (target === ready.main.name) {
				const sure = await this.deps.ui.confirm(
					'You are copying into the main database.',
					`${ready.main.name} is the database the main branches use. All of it, including its migration history, is replaced with ${source}. Are you sure?`,
					'Yes, Copy Into Main',
				);
				if (!sure) {
					return;
				}
			}
			const copied = await this.copyDatabase(ready, source, target, databases.includes(target));
			if (!copied) {
				return;
			}
			await this.deps.store.updateMeta(target, { lastCopiedFrom: source, lastCopiedAt: new Date(this.now()).toISOString() });
			await this.refresh();
			if (ready.config.migrations.afterCopy && ready.config.migrations.command) {
				await this.runMigrationsOn(target, false, true);
			}
			void this.deps.ui.info(`Copied ${source} into ${target}.`);
		});
	}

	async switchDatabase(name?: string): Promise<void> {
		await this.guard('Switching database', async () => {
			const ready = this.ready();
			const branch = this.requireBranch(ready);
			const databases = (await ready.engine.listDatabases()).filter((db) => !MAINTENANCE_DATABASES.includes(db));
			const chosen = name ?? await this.deps.ui.pickOne(
				this.databaseItems(databases, ready, this.current?.database),
				`Use which database for "${branch}"?`,
			);
			if (!chosen) {
				return;
			}
			if (!databases.includes(chosen)) {
				throw new UserError(`Database "${chosen}" doesn't exist.`);
			}
			await this.linkCurrentBranch(ready, branch, chosen);
		});
	}

	async switchBack(): Promise<void> {
		const previous = this.deps.store.data().previous;
		if (!previous) {
			void this.deps.ui.info('There is no previous database to switch back to.');
			return;
		}
		await this.switchDatabase(previous);
	}

	async removeDatabase(name?: string): Promise<void> {
		await this.guard('Removing database', async () => {
			const ready = this.ready();
			const databases = await ready.engine.listDatabases();
			const removable = databases.filter((db) => db !== ready.main.name && !MAINTENANCE_DATABASES.includes(db));
			const chosen = name ?? await this.deps.ui.pickOne(this.databaseItems(removable, ready, undefined), 'Remove which database?');
			if (!chosen) {
				return;
			}
			if (chosen === ready.main.name || MAINTENANCE_DATABASES.includes(chosen)) {
				throw new UserError(`${chosen} can't be removed.`);
			}
			const drops = [chosen, ...this.testDatabasesOf(chosen, databases, ready.config)];
			const branches = this.deps.store.branchesOf(chosen);
			const ok = await this.deps.ui.confirm(
				`Drop ${chosen}?`,
				[
					`These databases are deleted for good: ${drops.join(', ')}.`,
					branches.length ? `Branches using it go back to the main database: ${branches.join(', ')}.` : '',
				].filter(Boolean).join('\n'),
				'Drop',
			);
			if (!ok) {
				return;
			}
			await this.deps.ui.withProgress(`Dropping ${chosen}`, async () => {
				for (const db of drops) {
					await ready.engine.drop(db);
				}
			});
			await this.deps.store.forgetDatabase(chosen);
			await this.refresh();
			void this.deps.ui.info(`Dropped ${drops.join(', ')}.`);
		});
	}

	async cleanUpDatabases(): Promise<void> {
		await this.guard('Cleaning up databases', async () => {
			const ready = this.ready();
			const databases = await ready.engine.listDatabases();
			const current = this.current?.database ?? ready.main.name;
			const protectedNames = new Set([ready.main.name, current, ...MAINTENANCE_DATABASES]);
			const currentTest = testDatabaseFor(ready.config, ready.env, current, current === ready.main.name)?.name;
			if (currentTest) {
				protectedNames.add(currentTest);
			}
			const candidates = databases.filter((db) => !protectedNames.has(db));
			if (candidates.length === 0) {
				void this.deps.ui.info('Nothing to clean up: only the main and current databases exist.');
				return;
			}
			const links = this.deps.store.data().links;
			const items: PickItem<string>[] = candidates.map((db) => {
				const branches = Object.entries(links).filter(([, link]) => link.database === db).map(([branch]) => branch);
				return {
					label: db,
					description: branches.length ? `linked to ${branches.join(', ')}` : undefined,
					value: db,
					picked: matchesAnyGlob(db, ready.config.database.hidePatterns),
				};
			});
			const chosen = await this.deps.ui.pickMany(items, 'Clean Up Databases', 'Pick the databases to drop (hidden ones are pre-selected)');
			if (!chosen || chosen.length === 0) {
				return;
			}
			const ok = await this.deps.ui.confirm(
				`Drop ${chosen.length} database${chosen.length === 1 ? '' : 's'}?`,
				chosen.join(', '),
				'Drop',
			);
			if (!ok) {
				return;
			}
			await this.deps.ui.withProgress('Dropping databases', async () => {
				for (const db of chosen) {
					await ready.engine.drop(db);
					await this.deps.store.forgetDatabase(db);
				}
			});
			await this.refresh();
			void this.deps.ui.info(`Dropped ${chosen.length} database${chosen.length === 1 ? '' : 's'}.`);
		});
	}

	/** Drops or unlinks the databases of branches that were merged into a main branch or deleted. */
	async checkFinishedBranches(): Promise<void> {
		if (this.checkingBranches || this.busy) {
			return;
		}
		const data = this.deps.store.data();
		if (Object.keys(data.links).length === 0) {
			return;
		}
		this.checkingBranches = true;
		try {
			const ready = this.ready();
			const local = await this.deps.git.localBranches();
			const mainBranch = ready.config.database.mainBranches.find((name) => local.has(name));
			const merged = mainBranch ? await this.deps.git.mergedInto(mainBranch) : new Set<string>();
			const finished = findFinishedLinks({
				links: data.links,
				currentBranch: ready.branch,
				mainBranches: ready.config.database.mainBranches,
				mainName: ready.main.name,
				localBranches: new Set(local.keys()),
				mergedBranches: merged,
				tips: Object.fromEntries(local),
			});
			if (finished.length === 0) {
				return;
			}
			const branchList = finished.map((item) => `${item.branch} (${item.reason})`).join(', ');
			if (ready.config.database.onBranchMerged === 'keep') {
				for (const item of finished) {
					await this.deps.store.unlink(item.branch);
				}
				await this.refresh();
				void this.deps.ui.info(`Unlinked databases of finished branches: ${branchList}. The databases were kept.`);
				return;
			}
			const existing = await ready.engine.listDatabases();
			const current = this.current?.database;
			const free = databasesFreeAfterUnlink(finished, data.links)
				.filter((db) => db !== ready.main.name && db !== current && !MAINTENANCE_DATABASES.includes(db));
			const dropped: string[] = [];
			for (const db of free) {
				for (const name of [db, ...this.testDatabasesOf(db, existing, ready.config)]) {
					if (existing.includes(name)) {
						await ready.engine.drop(name);
						dropped.push(name);
					}
				}
				await this.deps.store.forgetDatabase(db);
			}
			for (const item of finished) {
				await this.deps.store.unlink(item.branch);
			}
			await this.refresh();
			void this.deps.ui.info(
				dropped.length
					? `Dropped ${dropped.join(', ')}: ${branchList}.`
					: `Unlinked finished branches: ${branchList}.`,
			);
		} catch {
			// Database or git unavailable; try again on the next git change.
		} finally {
			this.checkingBranches = false;
		}
	}

	/** Checks the database again, and starts its container when Docker runs but the container doesn't. */
	async connectDatabase(): Promise<void> {
		await this.refresh();
		if (this.dockerProblem === 'containerStopped') {
			await this.startDatabase();
		}
	}

	async startDatabase(): Promise<void> {
		await this.guard('Starting database', async () => {
			const root = this.deps.root();
			const { config } = this.deps.readConfig();
			const docker = dockerTarget(config);
			if (!root || !docker) {
				throw new UserError('Set automatedProcesses.database.dockerContainer (or dockerComposeService) to start the database from here.');
			}
			const command = docker.kind === 'container'
				? `docker start ${docker.name}`
				: `docker compose up --detach --wait ${docker.name}`;
			const state = await this.deps.scripts.run(
				{ id: '__start', label: 'Start Database', icon: 'play', env: {}, inputs: {}, steps: [{ label: command, run: command }] },
				{ env: cleanEnv(this.deps.processEnv), cwd: root, context: { env: {}, inputs: {} } },
			);
			await this.refresh();
			if (state.status === 'failed') {
				throw new UserError(`Starting "${docker.name}" failed. See the terminal for details.`);
			}
		});
	}

	// ── Scripts ───────────────────────────────────────────────────────────────

	async runMigrations(): Promise<void> {
		await this.guard('Running migrations', async () => {
			await this.runMigrationsOn(this.current?.database ?? this.ready().main.name, true, false);
		});
	}

	/**
	 * Reverts migrations that other branches applied to the current database, back to the last
	 * revision this branch knows, then runs this branch's migrations. The revert runs with the
	 * other branch's code, in a temporary git worktree, because only it can undo its migrations.
	 */
	async syncMigrations(): Promise<void> {
		await this.guard('Syncing migrations', async () => {
			const ready = this.ready();
			const streams = ready.config.migrations.streams;
			if (streams.length === 0) {
				throw new UserError('No migration streams configured. Set automatedProcesses.migrations.streams to use Sync Migrations.');
			}
			const database = this.current?.database ?? ready.main.name;
			const isMain = database === ready.main.name;

			const reverts: { stream: MigrationStream; ref: string; foreign: string[]; target: string }[] = [];
			for (const stream of streams) {
				const patterns = { revision: stream.revisionPattern, downRevision: stream.downRevisionPattern };
				const applied = (await ready.engine.query(stream.versionQuery, database)).map((row) => row[0]).filter(Boolean);
				const known = new Set((await this.readGraph(stream.versionsPath, patterns)).keys());
				const foreignHeads = applied.filter((revision) => !known.has(revision));
				if (foreignHeads.length === 0) {
					continue;
				}
				const ref = (await this.deps.git.branchesContaining(foreignHeads[0], stream.versionsPath))
					.find((candidate) => candidate !== ready.branch);
				if (!ref) {
					throw new UserError(`${stream.name}: migration ${foreignHeads[0]} isn't in any branch, so it can't be reverted automatically.`);
				}
				const plan = planRevert(applied, known, await this.readGraph(stream.versionsPath, patterns, ref));
				if (plan.status === 'error') {
					throw new UserError(`${stream.name}: ${plan.message}`);
				}
				if (plan.status === 'revert') {
					reverts.push({ stream, ref, foreign: plan.foreign, target: plan.target });
				}
			}

			if (reverts.length === 0) {
				void this.deps.ui.info(`${database} only has migrations this branch knows. Nothing to revert.`);
				return;
			}
			const ok = await this.deps.ui.confirm(
				`Revert migrations from other branches on ${database}?`,
				[
					...reverts.map((item) => `${item.stream.name}: undo ${item.foreign.length} migration${item.foreign.length === 1 ? '' : 's'} from "${item.ref}" (${item.foreign.join(', ')}), back to ${item.target}.`),
					'',
					`Tables and data those migrations created are removed.${ready.config.migrations.command ? ' Then this branch\'s migrations run.' : ''}`,
				].join('\n'),
				'Revert',
			);
			if (!ok) {
				return;
			}

			const worktrees = new Map<string, string>();
			try {
				for (const item of reverts) {
					let worktree = worktrees.get(item.ref);
					if (!worktree) {
						worktree = await this.deps.git.addWorktree(item.ref);
						worktrees.set(item.ref, worktree);
					}
					const extra = { revision: item.target, worktree, workspaceFolder: ready.root };
					const env = buildCommandEnv({
						processEnv: this.deps.processEnv,
						config: ready.config,
						env: ready.env,
						database,
						isMain,
						branch: ready.branch,
						scriptEnv: item.stream.env,
						extra,
					});
					const state = await this.deps.scripts.run(
						{
							id: '__sync',
							label: 'Sync Migrations',
							icon: 'history',
							env: {},
							inputs: {},
							steps: [{ label: `Revert ${item.stream.name} to ${item.target}`, run: item.stream.downgradeCommand }],
						},
						{
							env,
							cwd: path.join(worktree, item.stream.cwd),
							context: placeholderContext(ready.config, ready.env, this.deps.processEnv, database, isMain, ready.branch, {}, extra),
						},
					);
					if (state.status !== 'passed') {
						throw new UserError(`Reverting ${item.stream.name} on ${database} failed; see the terminal. Earlier streams may already be reverted.`);
					}
				}
			} finally {
				for (const worktree of worktrees.values()) {
					await this.deps.git.removeWorktree(worktree).catch(() => undefined);
				}
			}

			if (ready.config.migrations.command) {
				await this.runMigrationsOn(database, false, true);
			}
			void this.deps.ui.info(`Reverted ${reverts.map((item) => `${item.stream.name} to ${item.target}`).join(', ')} on ${database}.`);
		});
	}

	private async readGraph(dir: string, patterns: { revision: string; downRevision: string }, ref?: string): Promise<MigrationGraph> {
		const files = await this.deps.git.listFiles(dir, ref);
		const texts = await Promise.all(files.map((file) => this.deps.git.readFile(file, ref)));
		return buildGraph(texts, patterns);
	}

	async runScript(scriptId: string, step?: number): Promise<RunState | undefined> {
		const { config } = this.deps.readConfig();
		const script = config.scripts.find((item) => item.id === scriptId);
		if (!script) {
			void this.deps.ui.error(`No script with id "${scriptId}" in automatedProcesses.scripts.`);
			return undefined;
		}
		try {
			return await this.runScriptDefinition(script, this.current?.database, step);
		} catch (error) {
			void this.deps.ui.error(messageOf(error));
			return undefined;
		}
	}

	cancelRun(): void {
		this.deps.scripts.cancel();
	}

	// ── Servers ───────────────────────────────────────────────────────────────

	/** Starts a server's command in its own terminal, with the current database. */
	async startServer(id?: string): Promise<void> {
		try {
			const server = this.server(id);
			if (!server.command) {
				throw new UserError(`"${server.label}" has no command; it can only be debugged.`);
			}
			await this.stopDebugSessionOf(server);
			await this.deps.server.startServer(server.id, server.label, server.command, this.currentCommandEnv(), this.readyWithoutEngine().root);
		} catch (error) {
			void this.deps.ui.error(messageOf(error));
		}
		this.changed();
	}

	/** Stops a server, whether it runs in its terminal or under the debugger. */
	async stopServer(id?: string): Promise<void> {
		try {
			const server = this.server(id);
			this.deps.server.stopServer(server.id);
			await this.stopDebugSessionOf(server);
		} catch (error) {
			void this.deps.ui.error(messageOf(error));
		}
		this.changed();
	}

	/** Starts a server under the debugger (its launch.json configuration) with the current database. */
	async debugServer(id?: string): Promise<void> {
		try {
			const server = this.server(id);
			const name = server.debugConfiguration;
			if (!name) {
				throw new UserError(`"${server.label}" has no debugConfiguration (a launch.json configuration name).`);
			}
			if (!this.deps.server.launchConfigurations().includes(name)) {
				throw new UserError(`Launch configuration "${name}" isn't in .vscode/launch.json.`);
			}
			// The terminal and the debugged server usually share a port.
			this.deps.server.stopServer(server.id);
			if (!await this.deps.server.startDebugging(name)) {
				throw new UserError(`VS Code couldn't start "${name}".`);
			}
		} catch (error) {
			void this.deps.ui.error(messageOf(error));
		}
		this.changed();
	}

	/**
	 * Restarts one server the way it's running (terminal or debugger), or, without an id, every
	 * running server and debug session. Restarting a stopped server starts it.
	 */
	async restartServer(id?: string): Promise<void> {
		if (id !== undefined) {
			try {
				const server = this.server(id);
				if (this.deps.server.runningDebugSessions().includes(server.debugConfiguration)) {
					await this.stopDebugSessionOf(server);
					await this.debugServer(server.id);
				} else {
					await this.startServer(server.id);
				}
			} catch (error) {
				void this.deps.ui.error(messageOf(error));
			}
			return;
		}
		const restarted = await this.restartRunning(false);
		if (restarted.length === 0) {
			void this.deps.ui.info('Nothing to restart: no server or debug session is running.');
		}
	}

	/** Runs after any action that changed the current database. */
	private async restartServersIfPending(): Promise<void> {
		if (!this.restartPending) {
			return;
		}
		this.restartPending = false;
		const { config } = this.deps.readConfig();
		const mode = config.server.onDatabaseChange;
		const running = this.restartableRunning(config);
		if (mode === 'off' || running.length === 0 || !this.current) {
			return;
		}
		const database = this.current.database;
		if (mode === 'ask') {
			// Not awaited: an unanswered notification must not hold up the action that switched.
			void this.deps.ui.info(`Now using ${database}. Restart ${running.join(', ')} so it uses it too?`, 'Restart')
				.then((choice) => (choice === 'Restart' ? this.restartRunning(true) : undefined));
			return;
		}
		const restarted = await this.restartRunning(true);
		if (restarted.length > 0) {
			void this.deps.ui.info(`Restarted ${restarted.join(', ')} on ${database}.`);
		}
	}

	/** Labels of running servers and debug sessions that a database change restarts. */
	private restartableRunning(config: Config): string[] {
		const terminals = new Set(this.deps.server.runningServers());
		const skipped = this.skippedDebugSessions(config);
		return [
			...config.servers.filter((server) => server.restartOnDatabaseChange && terminals.has(server.id)).map((server) => server.label),
			...this.deps.server.runningDebugSessions().filter((name) => !skipped.includes(name)),
		];
	}

	/** Debug sessions of servers that opted out of restarting. */
	private skippedDebugSessions(config: Config): string[] {
		return config.servers.filter((server) => !server.restartOnDatabaseChange && server.debugConfiguration)
			.map((server) => server.debugConfiguration);
	}

	/**
	 * Restarts running server terminals and debug sessions with the current database.
	 * `onlyDatabaseDependent` skips servers with `restartOnDatabaseChange: false`.
	 */
	private async restartRunning(onlyDatabaseDependent: boolean): Promise<string[]> {
		const restarted: string[] = [];
		try {
			const { config } = this.deps.readConfig();
			const terminals = new Set(this.deps.server.runningServers());
			for (const server of config.servers) {
				if (terminals.has(server.id) && server.command && (server.restartOnDatabaseChange || !onlyDatabaseDependent)) {
					await this.deps.server.startServer(server.id, server.label, server.command, this.currentCommandEnv(), this.readyWithoutEngine().root);
					restarted.push(server.label);
				}
			}
			restarted.push(...await this.deps.server.restartDebugSessions(onlyDatabaseDependent ? this.skippedDebugSessions(config) : []));
		} catch (error) {
			void this.deps.ui.error(`Couldn't restart: ${messageOf(error)}`);
		}
		this.changed();
		return restarted;
	}

	private server(id?: string): ServerDefinition {
		const { config } = this.deps.readConfig();
		const server = id === undefined ? config.servers[0] : config.servers.find((item) => item.id === id);
		if (!server) {
			throw new UserError(id === undefined
				? 'No servers configured. Add them to automatedProcesses.servers (or set automatedProcesses.server.command).'
				: `No server with id "${id}" in automatedProcesses.servers.`);
		}
		return server;
	}

	private async stopDebugSessionOf(server: ServerDefinition): Promise<void> {
		if (server.debugConfiguration && this.deps.server.runningDebugSessions().includes(server.debugConfiguration)) {
			await this.deps.server.stopDebugging(server.debugConfiguration);
		}
	}

	private currentCommandEnv(): EnvMap {
		const ready = this.readyWithoutEngine();
		const database = this.current?.database ?? ready.main.name;
		return buildCommandEnv({
			processEnv: this.deps.processEnv,
			config: ready.config,
			env: ready.env,
			database,
			isMain: database === ready.main.name,
			branch: ready.branch,
		});
	}

	private willMigrateAutomatically(branch: string): boolean {
		const { config } = this.deps.readConfig();
		// Mirrors afterBranchSwitch: a feature branch without its own database never migrates.
		const skipsMigrations = !this.current?.linked && !isMainBranch(branch, config.database.mainBranches);
		return config.migrations.onBranchChange === 'always' && config.migrations.command !== '' && !skipsMigrations;
	}

	async setInput(scriptId: string, name: string, value: string): Promise<void> {
		const inputs = this.deps.prefs.get<Record<string, Record<string, string>>>(PREF_INPUTS) ?? {};
		inputs[scriptId] = { ...inputs[scriptId], [name]: value };
		await this.deps.prefs.update(PREF_INPUTS, inputs);
		this.changed();
	}

	async setShowHidden(value: boolean): Promise<void> {
		await this.deps.prefs.update(PREF_SHOW_HIDDEN, value);
		this.changed();
	}

	async setOnBranchChange(value: BranchChangeMode): Promise<void> {
		await this.deps.settings.update('migrations.onBranchChange', value);
	}

	async setServerRestartMode(value: ServerRestartMode): Promise<void> {
		await this.deps.settings.update('server.onDatabaseChange', value);
	}

	async setImportDataOnCreate(value: boolean): Promise<void> {
		await this.deps.settings.update('database.importDataOnCreate', value);
	}

	openSettings(): void {
		this.deps.settings.open();
	}

	// ── Internals ─────────────────────────────────────────────────────────────

	/** The branch got new commits (pull, merge, rebase): run the `onGitUpdate` script if it applies. */
	private async afterBranchUpdated(branch: string, from: string, to: string): Promise<void> {
		const { config } = this.deps.readConfig();
		const settings = config.onGitUpdate;
		const script = config.scripts.find((item) => item.id === settings.script);
		if (!script || settings.mode === 'off' || (settings.skipMainBranches && isMainBranch(branch, config.database.mainBranches))) {
			return;
		}
		let reason = 'it has new commits';
		if (settings.whenFilesChange.length > 0) {
			const changed = (await this.deps.git.changedFiles(from, to).catch(() => []))
				.filter((file) => matchesAnyGlob(file, settings.whenFilesChange));
			if (changed.length === 0) {
				return;
			}
			reason = `${changed.join(', ')} changed`;
		}
		if (settings.mode === 'ask') {
			const choice = await this.deps.ui.info(`"${branch}" was updated and ${reason}. Run ${script.label}?`, `Run ${script.label}`);
			if (choice !== `Run ${script.label}`) {
				return;
			}
		} else {
			void this.deps.ui.info(`"${branch}" was updated and ${reason}. Running ${script.label}…`);
		}
		const state = await this.runScript(script.id);
		if (state?.status === 'failed') {
			void this.deps.ui.error(`${script.label} failed. See the terminal for details.`);
		}
	}

	async setGitUpdateMode(value: BranchChangeMode): Promise<void> {
		await this.deps.settings.update('onGitUpdate.mode', value);
	}

	private async afterBranchSwitch(branch: string): Promise<void> {
		const { config } = this.deps.readConfig();
		const current = this.current;
		if (!current) {
			return;
		}
		if (!current.linked && !isMainBranch(branch, config.database.mainBranches)) {
			const choice = await this.deps.ui.info(
				`"${branch}" has no database of its own, so it's using the main database (${current.database}). Migrations were not run.`,
				'New Database',
			);
			if (choice === 'New Database') {
				await this.newDatabase();
			}
			return;
		}
		const mode = config.migrations.onBranchChange;
		if (!config.migrations.command || mode === 'off') {
			return;
		}
		if (mode === 'ask') {
			const choice = await this.deps.ui.info(`Switched to ${current.database}. Run migrations on it?`, 'Run Migrations');
			if (choice !== 'Run Migrations') {
				return;
			}
		}
		await this.guard('Running migrations', () => this.runMigrationsOn(current.database, true, false));
	}

	/** Runs the migrations command against `database`, warning first when that's main on a feature branch. */
	private async runMigrationsOn(database: string, warnOnMain: boolean, quietOnSuccess: boolean): Promise<void> {
		const { config } = this.deps.readConfig();
		if (!config.migrations.command) {
			throw new UserError('No migrations command. Set automatedProcesses.migrations.command.');
		}
		const branch = this.deps.git.currentBranch();
		if (warnOnMain && database === this.mainName && !isMainBranch(branch, config.database.mainBranches)) {
			const go = await this.deps.ui.confirm(
				`Run migrations on the main database from "${branch ?? 'no branch'}"?`,
				`This applies this branch's migrations to ${database}, which every branch shares. Other branches won't know about them. Use "New Database" to give this branch its own copy instead.`,
				'Run on Main Anyway',
			);
			if (!go) {
				return;
			}
		}
		const state = await this.runScriptDefinition(
			{ id: MIGRATIONS_SCRIPT_ID, label: 'Run Migrations', icon: 'arrow-up', env: {}, inputs: {}, steps: [{ label: `Migrations on ${database}`, run: config.migrations.command }] },
			database,
		);
		if (state.status === 'failed') {
			throw new UserError(`Migrations on ${database} failed. See the terminal for details.`);
		}
		if (!quietOnSuccess && state.status === 'passed') {
			void this.deps.ui.info(`Migrations applied to ${database}.`);
		}
	}

	private async runScriptDefinition(script: ScriptDefinition, database: string | undefined, step?: number): Promise<RunState> {
		const ready = this.readyWithoutEngine();
		const db = database ?? ready.main.name;
		const isMain = db === ready.main.name;
		const stored = this.deps.prefs.get<Record<string, Record<string, string>>>(PREF_INPUTS)?.[script.id] ?? {};
		const inputs: Record<string, string> = {};
		for (const [name, input] of Object.entries(script.inputs)) {
			inputs[name] = stored[name] && input.options.includes(stored[name]) ? stored[name] : input.default;
		}
		const env = buildCommandEnv({
			processEnv: this.deps.processEnv,
			config: ready.config,
			env: ready.env,
			database: db,
			isMain,
			branch: ready.branch,
			scriptEnv: script.env,
			inputs,
		});
		const context = placeholderContext(ready.config, ready.env, this.deps.processEnv, db, isMain, ready.branch, inputs);
		return this.deps.scripts.run(script, { env, cwd: ready.root, context, onlyStep: step });
	}

	/**
	 * Replaces `target` with a copy of `source`. Fast template copy when nothing is connected to
	 * the source; otherwise asks to disconnect or fall back to dump/restore.
	 */
	private async copyDatabase(ready: Ready, source: string, target: string, targetExists: boolean): Promise<boolean> {
		const connections = await ready.engine.connections(source);
		let method: 'template' | 'dump' = 'template';
		if (connections.length > 0) {
			const lines = connections.slice(0, 8).map((c) => `• ${c.application || 'unnamed client'} (${c.user}@${c.client}${c.state ? `, ${c.state}` : ''})`);
			if (connections.length > 8) {
				lines.push(`• …and ${connections.length - 8} more`);
			}
			const choice = await this.deps.ui.choose(
				`${connections.length} session${connections.length === 1 ? ' is' : 's are'} connected to ${source}.`,
				`The fast copy needs ${source} to have no other connections.\n${lines.join('\n')}\n\n"Disconnect and Copy" ends those sessions (apps reconnect on their next query). "Copy Without Disconnecting" is slower and interrupts nothing.`,
				['Disconnect and Copy', 'Copy Without Disconnecting'],
			);
			if (!choice) {
				return false;
			}
			if (choice === 'Disconnect and Copy') {
				await ready.engine.terminateConnections(source);
			} else {
				method = 'dump';
			}
		}
		await this.deps.ui.withProgress(`Copying ${source} → ${target}`, async () => {
			if (targetExists) {
				await ready.engine.drop(target);
			}
			if (method === 'template') {
				try {
					await ready.engine.createFromTemplate(target, source);
				} catch (error) {
					if (!isTemplateInUse(error)) {
						throw error;
					}
					method = 'dump';
				}
			}
			if (method === 'dump') {
				await ready.engine.createEmpty(target);
				try {
					await ready.engine.dumpRestore(source, target);
				} catch (error) {
					await ready.engine.drop(target).catch(() => undefined);
					throw error;
				}
			}
			await ready.engine.copySettings(source, target);
		});
		return true;
	}

	private async linkCurrentBranch(ready: Ready, branch: string, database: string): Promise<void> {
		if (database === ready.main.name) {
			await this.deps.store.unlink(branch);
		} else {
			const tips = await this.deps.git.localBranches().catch(() => new Map<string, string>());
			const existing = this.deps.store.linkOf(branch);
			await this.deps.store.link(branch, database, existing?.database === database ? existing.linkedAtCommit : tips.get(branch));
		}
		await this.refresh();
	}

	private databaseItems(databases: string[], ready: Ready, preferred: string | undefined): PickItem<string>[] {
		const data = this.deps.store.data();
		const items = databases.map((db) => {
			const tags: string[] = [];
			if (db === ready.main.name) {
				tags.push('main');
			}
			if (db === this.current?.database) {
				tags.push('current');
			}
			if (db === data.previous) {
				tags.push('previous');
			}
			const branches = Object.entries(data.links).filter(([, link]) => link.database === db).map(([branch]) => branch);
			return {
				label: db === ready.main.name ? `$(star-full) ${db}` : db === this.current?.database ? `$(circle-filled) ${db}` : db,
				description: tags.join(' · ') || undefined,
				detail: branches.length ? `Branch: ${branches.join(', ')}` : undefined,
				value: db,
				picked: db === preferred,
			};
		});
		items.sort((a, b) => Number(b.value === preferred) - Number(a.value === preferred)
			|| Number(b.value === ready.main.name) - Number(a.value === ready.main.name)
			|| a.value.localeCompare(b.value));
		return items;
	}

	private testDatabasesOf(database: string, existing: string[], config: Config): string[] {
		const base = testDatabaseName(database, config.testDatabase.nameSuffix);
		return existing.filter((db) => db === base || matchesGlob(db, `${base}_*`));
	}

	private readyWithoutEngine(): Omit<Ready, 'engine'> {
		const root = this.deps.root();
		if (!root) {
			throw new UserError('Open a folder first.');
		}
		const { config } = this.deps.readConfig();
		let env: ProjectEnv;
		let main: MainDatabase;
		try {
			env = this.deps.readEnv(root, config);
			main = mainDatabase(config, env);
		} catch (error) {
			throw new UserError(messageOf(error));
		}
		return { config, root, env, main, branch: this.deps.git.currentBranch() };
	}

	private ready(): Ready {
		const partial = this.readyWithoutEngine();
		return { ...partial, engine: this.engineFor(partial.config, partial.root, partial.main) };
	}

	private engineFor(config: Config, root: string, main: MainDatabase): DatabaseEngine {
		const parts = parseDbUrl(main.url);
		return this.deps.createEngine({
			user: parts.user,
			password: parts.password,
			host: parts.host,
			port: parts.port,
			dockerContainer: config.database.dockerContainer || undefined,
			dockerComposeService: config.database.dockerComposeService || undefined,
			cwd: root,
			processEnv: cleanEnv(this.deps.processEnv),
		});
	}

	private requireBranch(ready: Ready): string {
		if (!ready.branch) {
			throw new UserError('No git branch is checked out (detached HEAD or no repository).');
		}
		return ready.branch;
	}

	/** Runs one user action at a time, shows errors, keeps the view's busy label up to date. */
	private async guard(label: string, action: () => Promise<void>): Promise<void> {
		if (this.busy) {
			void this.deps.ui.info(`Please wait: ${this.busy.toLowerCase()}…`);
			return;
		}
		this.busy = label;
		this.changed();
		try {
			await action();
		} catch (error) {
			void this.deps.ui.error(messageOf(error));
		} finally {
			this.busy = undefined;
			this.changed();
		}
		await this.restartServersIfPending();
	}

	private changed(): void {
		this.deps.onDidChange();
	}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}
}

/** Where the database runs in Docker, if anywhere. A container wins over a Compose service. */
function dockerTarget(config: Config): { kind: 'container' | 'compose'; name: string } | undefined {
	if (config.database.dockerContainer) {
		return { kind: 'container', name: config.database.dockerContainer };
	}
	if (config.database.dockerComposeService) {
		return { kind: 'compose', name: config.database.dockerComposeService };
	}
	return undefined;
}

function uniqueName(name: string, existing: Set<string>): string {
	if (!existing.has(name)) {
		return name;
	}
	for (let index = 2; ; index++) {
		const candidate = `${name.slice(0, 60)}_${index}`;
		if (!existing.has(candidate)) {
			return candidate;
		}
	}
}

function cleanEnv(env: Record<string, string | undefined>): EnvMap {
	const result: EnvMap = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) {
			result[key] = value;
		}
	}
	return result;
}

export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
