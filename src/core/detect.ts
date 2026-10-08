/**
 * "Add defaults": guesses servers, scripts and migrations from the project's files: package.json
 * (Node), pyproject.toml / requirements.txt / manage.py (Python), Alembic, Prisma and launch.json.
 * Looks at the workspace folder and its direct subfolders (e.g. `frontend/`, `backend/`).
 */

import * as fs from 'fs';
import * as path from 'path';
import { ScriptDefinition, ServerDefinition } from './config';

export interface ProjectFiles {
	/** Text of a file (path relative to the workspace, with `/`), or undefined. */
	read(file: string): string | undefined;
	exists(file: string): boolean;
	/** Subfolder names of a folder. */
	folders(folder: string): string[];
	/** File names in a folder. */
	files(folder: string): string[];
}

export interface DetectedStream {
	name: string;
	versionQuery: string;
	versionsPath: string;
	downgradeCommand: string;
	cwd: string;
}

export type Suggestion =
	| { id: string; kind: 'server'; label: string; detail: string; server: ServerDefinition }
	| { id: string; kind: 'script'; label: string; detail: string; script: ScriptDefinition }
	| { id: string; kind: 'migrations'; label: string; detail: string; command: string; cwd: string }
	| { id: string; kind: 'stream'; label: string; detail: string; stream: DetectedStream };

const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'venv', '__pycache__', 'coverage', 'vendor']);
const FRONTEND_PACKAGES = ['vite', 'next', 'react-scripts', '@angular/core', 'nuxt', '@sveltejs/kit', 'astro', '@remix-run/dev', 'vue', 'svelte', 'react'];
const BACKEND_PACKAGES = ['express', 'fastify', '@nestjs/core', 'koa', 'hono', '@hapi/hapi'];

export function detectDefaults(files: ProjectFiles, launchConfigurations: readonly string[] = []): Suggestion[] {
	const folders = ['', ...files.folders('').filter((name) => !name.startsWith('.') && !SKIPPED_FOLDERS.has(name))];
	const suggestions: Suggestion[] = [];
	const multiple = folders.filter((folder) => isProject(files, folder)).length > 1;
	for (const folder of folders) {
		suggestions.push(...detectNode(files, folder, multiple), ...detectPython(files, folder, multiple));
	}
	for (const name of launchConfigurations) {
		suggestions.push({
			id: `launch:${name}`,
			kind: 'server',
			label: name,
			detail: 'launch.json configuration (debug button)',
			server: { id: slug(name), label: name, command: '', debugConfiguration: name, restartOnDatabaseChange: true },
		});
	}
	return dedupe(suggestions);
}

function isProject(files: ProjectFiles, folder: string): boolean {
	return ['package.json', 'pyproject.toml', 'requirements.txt', 'manage.py'].some((file) => files.exists(join(folder, file)));
}

// ── Node ─────────────────────────────────────────────────────────────────────

interface PackageJson {
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

function detectNode(files: ProjectFiles, folder: string, multiple: boolean): Suggestion[] {
	const text = files.read(join(folder, 'package.json'));
	if (!text) {
		return [];
	}
	let pkg: PackageJson;
	try {
		pkg = JSON.parse(text) as PackageJson;
	} catch {
		return [];
	}
	const scripts = pkg.scripts ?? {};
	const deps = { ...pkg.devDependencies, ...pkg.dependencies };
	const has = (name: string) => name in deps;
	const pm = packageManager(files, folder);
	const run = (script: string) => (pm === 'npm' && script === 'test' ? 'npm test' : `${pm} run ${script}`);
	const where = folder ? ` (${folder})` : '';
	const suffix = multiple && folder ? ` (${folder})` : '';
	const cwd = folder;
	const result: Suggestion[] = [];

	const serverScript = ['dev', 'start', 'serve'].find((name) => scripts[name]);
	if (serverScript) {
		const frontend = FRONTEND_PACKAGES.some(has) && !BACKEND_PACKAGES.some(has);
		const label = `${frontend ? 'Frontend' : BACKEND_PACKAGES.some(has) ? 'Backend' : 'Server'}${suffix}`;
		result.push({
			id: `node-server:${folder}`,
			kind: 'server',
			label,
			detail: `${run(serverScript)}${where}${frontend ? ' · not restarted on database change' : ''}`,
			// A frontend doesn't talk to the database, so switching databases leaves it running.
			server: { id: slug(label), label, command: run(serverScript), debugConfiguration: '', restartOnDatabaseChange: !frontend, ...(cwd ? { cwd } : {}) },
		});
	}

	const install = pm === 'npm' ? (files.exists(join(folder, 'package-lock.json')) ? 'npm ci' : 'npm install') : `${pm} install`;
	result.push(script(`node-install:${folder}`, `Install dependencies${suffix}`, 'package', [{ label: install, run: install }], cwd, `${install}${where}`));

	const checks = ['lint', 'typecheck', 'type-check', 'test', 'build'].filter((name) => scripts[name] && !/no test specified/.test(scripts[name]));
	if (checks.length > 0) {
		result.push(script(`node-check:${folder}`, `Check${suffix}`, 'checklist', checks.map((name) => ({ label: name, run: run(name) })), cwd, checks.map(run).join(' → ') + where));
	}

	const migrateScript = ['migrate', 'db:migrate', 'migrate:deploy', 'migration:run'].find((name) => scripts[name]);
	const prisma = has('prisma') || files.exists(join(folder, 'prisma/schema.prisma'));
	const migrate = migrateScript ? run(migrateScript) : prisma ? `${pm === 'npm' ? 'npx' : `${pm} exec`} prisma migrate deploy` : undefined;
	if (migrate) {
		result.push({ id: `node-migrations:${folder}`, kind: 'migrations', label: `Migrations${suffix}`, detail: `${migrate}${where}`, command: migrate, cwd });
	}
	return result;
}

function packageManager(files: ProjectFiles, folder: string): 'npm' | 'pnpm' | 'yarn' | 'bun' {
	for (const at of [folder, '']) {
		if (files.exists(join(at, 'pnpm-lock.yaml'))) {
			return 'pnpm';
		}
		if (files.exists(join(at, 'yarn.lock'))) {
			return 'yarn';
		}
		if (files.exists(join(at, 'bun.lockb')) || files.exists(join(at, 'bun.lock'))) {
			return 'bun';
		}
		if (files.exists(join(at, 'package-lock.json'))) {
			return 'npm';
		}
	}
	return 'npm';
}

// ── Python ───────────────────────────────────────────────────────────────────

function detectPython(files: ProjectFiles, folder: string, multiple: boolean): Suggestion[] {
	const pyproject = files.read(join(folder, 'pyproject.toml')) ?? '';
	const requirements = files.read(join(folder, 'requirements.txt')) ?? '';
	const djangoManage = files.exists(join(folder, 'manage.py'));
	if (!pyproject && !requirements && !djangoManage) {
		return [];
	}
	const deps = `${pyproject}\n${requirements}`.toLowerCase();
	const has = (name: string) => new RegExp(`(^|[\\s"'\\[,])${name.replace(/[-_]/g, '[-_]')}([\\s"'<>=~!\\[;,]|$)`, 'm').test(deps);
	const runner = files.exists(join(folder, 'uv.lock')) || files.exists('uv.lock') ? 'uv run '
		: files.exists(join(folder, 'poetry.lock')) ? 'poetry run '
			: files.exists(join(folder, 'Pipfile')) ? 'pipenv run ' : '';
	const python = runner ? `${runner}python` : 'python';
	const where = folder ? ` (${folder})` : '';
	const suffix = multiple && folder ? ` (${folder})` : '';
	const cwd = folder;
	const result: Suggestion[] = [];

	// Server: Django, FastAPI (uvicorn) or Flask, from the code itself.
	let command: string | undefined;
	if (djangoManage) {
		command = `${python} manage.py runserver`;
	} else {
		const app = findPythonApp(files, folder);
		if (app?.framework === 'fastapi') {
			command = `${runner}uvicorn ${app.module}:${app.variable} --reload`;
		} else if (app?.framework === 'flask') {
			command = `${runner}flask --app ${app.module}:${app.variable} run --debug`;
		}
	}
	if (command) {
		const label = `Backend${suffix}`;
		result.push({ id: `python-server:${folder}`, kind: 'server', label, detail: `${command}${where}`, server: { id: slug(label), label, command, debugConfiguration: '', restartOnDatabaseChange: true, ...(cwd ? { cwd } : {}) } });
	}

	const install = runner === 'uv run ' ? 'uv sync'
		: runner === 'poetry run ' ? 'poetry install'
			: runner === 'pipenv run ' ? 'pipenv install --dev'
				: requirements ? 'pip install -r requirements.txt' : 'pip install -e .';
	result.push(script(`python-install:${folder}`, `Install Python dependencies${suffix}`, 'package', [{ label: install, run: install }], cwd, `${install}${where}`));

	const checks: { label: string; run: string }[] = [];
	if (has('ruff')) {
		checks.push({ label: 'Lint', run: `${runner}ruff check .` });
	}
	if (has('mypy')) {
		checks.push({ label: 'Types', run: `${runner}mypy .` });
	}
	if (has('pyright')) {
		checks.push({ label: 'Types', run: `${runner}pyright` });
	}
	if (has('pytest') || files.exists(join(folder, 'pytest.ini')) || files.exists(join(folder, 'tests'))) {
		checks.push({ label: 'Tests', run: djangoManage && !has('pytest') ? `${python} manage.py test` : `${runner}pytest` });
	}
	if (checks.length > 0) {
		result.push(script(`python-check:${folder}`, `Check Python${suffix}`, 'checklist', checks, cwd, checks.map((check) => check.run).join(' → ') + where));
	}

	// Migrations: Django or Alembic, plus an Alembic stream for Sync Migrations.
	const alembicIni = files.read(join(folder, 'alembic.ini'));
	if (djangoManage) {
		const migrate = `${python} manage.py migrate`;
		result.push({ id: `django-migrations:${folder}`, kind: 'migrations', label: `Migrations${suffix}`, detail: `${migrate}${where}`, command: migrate, cwd });
	} else if (alembicIni !== undefined) {
		const migrate = `${runner}alembic upgrade head`;
		const location = /^\s*script_location\s*=\s*(.+)$/m.exec(alembicIni)?.[1].trim().replace(/^%\(here\)s[\\/]/, '') ?? 'alembic';
		result.push({ id: `alembic-migrations:${folder}`, kind: 'migrations', label: `Migrations${suffix}`, detail: `${migrate}${where}`, command: migrate, cwd });
		result.push({
			id: `alembic-stream:${folder}`,
			kind: 'stream',
			label: `Alembic history${suffix}`,
			detail: `Sync Migrations: ${join(join(folder, location), 'versions')}`,
			stream: {
				name: folder || 'alembic',
				versionQuery: 'SELECT version_num FROM alembic_version',
				versionsPath: join(join(folder, location), 'versions'),
				downgradeCommand: `${runner}alembic downgrade \${revision}`,
				cwd: folder || '.',
			},
		});
	}
	return result;
}

/** The FastAPI or Flask app object: `app = FastAPI(` in `src/api/main.py` → module `src.api.main`. */
function findPythonApp(files: ProjectFiles, folder: string): { framework: 'fastapi' | 'flask'; module: string; variable: string } | undefined {
	const candidates: string[] = [];
	const visit = (dir: string, depth: number) => {
		for (const file of files.files(join(folder, dir))) {
			if (file.endsWith('.py')) {
				candidates.push(join(dir, file));
			}
		}
		if (depth < 3) {
			for (const sub of files.folders(join(folder, dir))) {
				if (!sub.startsWith('.') && !SKIPPED_FOLDERS.has(sub) && sub !== 'tests' && sub !== 'migrations' && sub !== 'alembic') {
					visit(join(dir, sub), depth + 1);
				}
			}
		}
	};
	visit('', 0);
	// Likely entry points first.
	candidates.sort((a, b) => rank(a) - rank(b) || a.split('/').length - b.split('/').length);
	for (const file of candidates.slice(0, 200)) {
		const text = files.read(join(folder, file)) ?? '';
		const fastapi = /^(\w+)\s*(?::\s*\w+\s*)?=\s*FastAPI\(/m.exec(text);
		const flask = /^(\w+)\s*=\s*Flask\(/m.exec(text);
		const match = fastapi ?? flask;
		if (match) {
			const module = file.replace(/\.py$/, '').replace(/^src\//, (prefix) => (files.exists(join(folder, 'src/__init__.py')) ? prefix : '')).split('/').join('.');
			return { framework: fastapi ? 'fastapi' : 'flask', module, variable: match[1] };
		}
	}
	return undefined;
}

function rank(file: string): number {
	const name = file.split('/').pop() ?? '';
	return ['main.py', 'app.py', 'server.py', 'api.py', 'wsgi.py', 'asgi.py'].includes(name) ? 0 : 1;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function script(id: string, label: string, icon: string, steps: { label: string; run: string }[], cwd: string, detail: string): Suggestion {
	return { id, kind: 'script', label, detail, script: { id: slug(label), label, icon, env: {}, inputs: {}, steps, ...(cwd ? { cwd } : {}) } };
}

function dedupe(suggestions: Suggestion[]): Suggestion[] {
	const seen = new Set<string>();
	return suggestions.filter((item) => !seen.has(item.id) && seen.add(item.id));
}

function join(folder: string, file: string): string {
	return folder ? (file ? `${folder}/${file}` : folder) : file;
}

function slug(label: string): string {
	return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
}

/** Reads the real workspace. Files over 512 KB are skipped. */
export function nodeProjectFiles(root: string): ProjectFiles {
	const full = (file: string) => path.join(root, ...file.split('/').filter(Boolean));
	const entries = (folder: string) => {
		try {
			return fs.readdirSync(full(folder), { withFileTypes: true });
		} catch {
			return [];
		}
	};
	return {
		read: (file) => {
			try {
				const stat = fs.statSync(full(file));
				return stat.isFile() && stat.size <= 512 * 1024 ? fs.readFileSync(full(file), 'utf8') : undefined;
			} catch {
				return undefined;
			}
		},
		exists: (file) => fs.existsSync(full(file)),
		folders: (folder) => entries(folder).filter((entry) => entry.isDirectory()).map((entry) => entry.name),
		files: (folder) => entries(folder).filter((entry) => entry.isFile()).map((entry) => entry.name),
	};
}
