# Automated Processes

A VS Code extension that gives each git branch its own PostgreSQL or SQLite database and turns
project scripts into sidebar buttons. It knows nothing about any particular project: everything
project-specific is a setting, edited in the **Configure** panel or as `automatedProcesses.*` in
`settings.json`.

- **Per-branch databases.** `New Database` copies the main database for the current branch and
  runs migrations on it. Switching branches switches the database. Databases of merged branches
  are dropped (or kept, by setting).
- **Backup, export, import.** **Backup** saves a database to a file. **Export Data** copies a
  database into another one or to a file; **Import Data** replaces the current one with another
  database or a file, after backing it up. Files are `pg_dump` archives (PostgreSQL) or database
  files (SQLite). Backups go to the extension's storage, outside the repository, unless
  `database.backupFolder` says otherwise.
- **No `.env` editing.** The current database is passed to scripts, new terminals and debug
  sessions as environment variables, which override `.env` in most frameworks.
- **Works on Windows.** With `loadEnvFileIntoCommands` (on by default), every value from `.env` is
  passed to commands, for tools that only read real environment variables.
- **Script buttons.** Steps run one after another as VS Code tasks and stop at the first
  failure. The sidebar shows each step's state.
- **Servers.** Run, debug, restart and stop buttons for your app's servers. Every `launch`
  configuration in `.vscode/launch.json` is one, listed first.

The design and decisions are in [PLAN.md](PLAN.md).

## Sidebar

Four views, each with its own title bar buttons: **Database**, **Servers** (run, debug, restart,
stop), **Scripts** (with Run Migrations and Sync Migrations) and **Settings** (the
on-branch-change and restart options; collapsed at the bottom). Drag the dividers to resize them,
collapse the ones you don't need, or drag them to reorder.

Scripts can also run by themselves: when VS Code starts, when the branch changes, when the branch
gets new commits (pull, merge, rebase; optionally only when e.g. `package-lock.json` changed, for
updating dependencies) or when a file is saved (optionally only e.g. `*.py`). All off by default;
an automatic run is skipped while another script runs. Servers can start with VS Code. Scripts and
servers also run when there's no database connection, just without the database variables.

Scripts and servers run in background terminals: the terminal panel and focus stay where they
are. Their **output** links (or `revealTerminal`) show them.

The Database view lists only the main and the current database; **Show all databases** lists the
rest.

## Configure panel

The `+` and gear buttons in the sidebar (or **Automated Processes: Configure Database, Servers and
Scripts**) open an editor tab with three tabs:

- **Database:** the engine (PostgreSQL, SQLite or detect from the URL), where the connection URL
  comes from (the env file, or typed in; a typed URL is kept in VS Code's secret storage), where
  the PostgreSQL tools run (this machine, a Docker container or a Compose service), and the main
  branches. **Test connection** checks it.
- **Servers:** add, edit and delete servers (name, run command, folder, launch.json configuration
  to debug with, restart on database change). The launch.json list has **Add as server** for each
  configuration.
- **Scripts:** add, edit, reorder and delete scripts: icon (searchable picker over every codicon),
  steps, folder, when they run by themselves, variables and dropdowns. Below them, **Migrations**: the Run Migrations command and folder, when it runs, and
  the histories Sync Migrations reverts.

**Add defaults** (Servers and Scripts) looks at the project and its direct subfolders and offers
what it finds, ticked unless it's already there:

| Found | Servers | Scripts | Migrations |
|---|---|---|---|
| `package.json` | `dev` / `start` script (a Vite, Next, React… app is a frontend: not restarted on database change) | install (npm, pnpm, yarn or bun), Check (lint, typecheck, test, build) | `migrate` script, or Prisma |
| Python (`pyproject.toml`, `requirements.txt`) | Django `runserver`, FastAPI (`uvicorn`) or Flask app found in the code | install (uv, poetry, pipenv or pip), Check (ruff, mypy/pyright, pytest) | Django `migrate`, Alembic (plus its Sync Migrations history) |
| `launch.json` | each `launch` configuration | | |

**Save for** at the top of each tab picks where saving goes: **This workspace** or **All
workspaces** (every project that doesn't have its own). Both are kept in the extension's storage on
your machine and override the same keys from `settings.json`; nothing in the repository changes.
**use settings.json** goes back.

## Requirements

- PostgreSQL, either in Docker (`database.dockerContainer` or `database.dockerComposeService`; nothing to
  install locally) or with `psql`, `pg_dump` and `pg_restore` on PATH. In Docker, a stopped database
  container is started when the extension starts; if Docker itself isn't running, the sidebar shows
  a Retry button for when it is. The user in the database URL needs the `CREATEDB` permission.
- Or SQLite: nothing to install. Each database is a file next to the main one, with the same
  extension (`app.db` → `app_347.db`); copies are file copies. Only **Sync Migrations** needs the
  `sqlite3` command line tool.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `envFile` | `.env` | Env file with the database URL (read only) |
| `loadEnvFileIntoCommands` | `true` | Pass env file values to every command |
| `loadEnvFileIntoTerminals` | `true` | Also pass them to new terminals and debug sessions; off = only the database URL variables and `env` |
| `env` | `{}` | Extra variables for every command (placeholders allowed) |
| `applyToTerminals` | `true` | Current database in new terminals |
| `applyToDebugSessions` | `true` | Current database in debug sessions of this folder (overrides the launch configuration's `envFile`) |
| `echoCommands` | `true` | Print each command, placeholders filled in, at the top of its terminal |
| `revealTerminal` | `never` | `never` / `onFailure` / `always`: when a script's or server's terminal comes into view (never focused) |
| `database.engine` | `auto` | `auto` (SQLite for SQLite URLs, else PostgreSQL) / `postgres` / `sqlite` |
| `database.urlVariables` | `["DATABASE_URL"]` | Variables pointed at the current database; the first defines main |
| `database.sqliteFolder` | `""` | SQLite: folder relative paths start from (e.g. `prisma`); empty = workspace |
| `database.mainBranches` | `["main"]` | Branches that use the main database |
| `database.dockerContainer` | `""` | Run Postgres tools in this container (`docker exec`) |
| `database.dockerComposeService` | `""` | Or in this Compose service (`docker compose exec`) |
| `database.backupFolder` | `""` | Backups and default export/import folder, relative to the workspace; empty = the extension's storage |
| `database.autoStartContainer` | `true` | Start a stopped database container on startup and Retry without asking |
| `database.warnIfPortExposed` | `true` | Warn when the container publishes its port on every network interface |
| `database.hidePatterns` | `["postgres"]` | Databases hidden from the list (globs) |
| `database.newNamePattern` | `{main}_{branchShort}` | Suggested new database name (`{main}`, `{branch}`, `{branchShort}`, `{issue}`) |
| `database.importDataOnCreate` | `true` | New Database imports the main database (schema and data); off = empty database + migrations |
| `database.onBranchMerged` | `delete` | `delete` or `keep` databases of merged/deleted branches |
| `testDatabase.envFile` | `""` | Env file with the test URL (empty = `envFile`) |
| `testDatabase.urlVariables` | `[]` | Variables pointed at the per-branch test database |
| `testDatabase.nameSuffix` | `_test` | Test database = branch database + suffix |
| `migrations.command` | `""` | Command that applies migrations |
| `migrations.cwd` | `""` | Folder it runs in, relative to the workspace |
| `migrations.onBranchChange` | `ask` | `off` / `ask` / `always` |
| `migrations.afterCopy` | `true` | Run migrations after **Export Data** |
| `migrations.streams` | `[]` | Migration histories for **Sync Migrations** (see below) |
| `servers` | `[]` | Servers in the sidebar (`label`, `command`, `cwd`, `debugConfiguration`, `restartOnDatabaseChange`), each with run, debug, restart and stop |
| `server.command` | `""` | Single-server shortcut, used only when `servers` is empty |
| `onGitUpdate.*` | | Older way to run a script on new commits; read as that script's `runOn.gitUpdate` (+ `gitUpdatePatterns`) |
| `server.onDatabaseChange` | `restart` | `restart` / `ask` / `off`: restart the server and running debug sessions when the database changes |
| `server.includeLaunchConfigurations` | `false` | Show every launch.json `launch` configuration as a server without adding it |
| `scripts` | `[]` | Sidebar script buttons |

Placeholders in commands and `env`: `${db.name}`, `${db.url}`, `${db.mainName}`, `${db.mainUrl}`,
`${testDb.name}`, `${testDb.url}`, `${env:NAME}`, `${input:NAME}`, `${branch}`.

What can leak (env file secrets, the database password, an exposed database port) and the
settings that control it are in [SECURITY-REPORT.md](SECURITY-REPORT.md).

### Example

```jsonc
{
  "automatedProcesses.database.urlVariables": ["DATABASE_URL", "DATABASE_ADMIN_URL"],
  "automatedProcesses.database.mainBranches": ["staging"],
  "automatedProcesses.database.dockerContainer": "carli-db-1",
  "automatedProcesses.database.hidePatterns": ["postgres", "*_test", "*_test_gw*"],
  "automatedProcesses.database.newNamePattern": "{main}_{issue}",
  "automatedProcesses.testDatabase.envFile": ".env.test",
  "automatedProcesses.testDatabase.urlVariables": ["TEST_DATABASE_URL"],
  "automatedProcesses.migrations.command": "uv run python -m carli_core.migrations.runner",
  "automatedProcesses.server.command": "uv run uvicorn carli_api.main:app --reload --port 8000",
  "automatedProcesses.migrations.streams": [
    {
      "name": "tenant",
      "versionQuery": "SELECT version_num FROM goodoaks.alembic_version",
      "versionsPath": "backend/migrations/versions",
      "cwd": "backend",
      "downgradeCommand": "uv run --no-sync alembic downgrade ${revision}",
      "env": { "UV_PROJECT_ENVIRONMENT": "${workspaceFolder}/.venv" }
    },
    {
      "name": "public",
      "versionQuery": "SELECT version_num FROM public.alembic_version_public",
      "versionsPath": "backend/migrations_public/versions",
      "cwd": "backend",
      "downgradeCommand": "uv run --no-sync alembic -c alembic_public.ini downgrade ${revision}",
      "env": { "UV_PROJECT_ENVIRONMENT": "${workspaceFolder}/.venv" }
    }
  ],
  "automatedProcesses.scripts": [
    {
      "id": "setup", "label": "Setup", "icon": "tools",
      "steps": [
        { "label": "Create .env", "copyFile": { "from": ".env.example", "to": ".env", "ifMissing": true } },
        { "label": "Python dependencies", "run": "uv sync --frozen" },
        { "label": "Node dependencies", "run": "npm ci" },
        { "label": "Start database", "run": "docker compose up --build --detach --wait db" },
        { "label": "Migrations", "run": "uv run python -m carli_core.migrations.runner" },
        { "label": "Seed", "run": "uv run python -m carli_platform.scripts.seed_local" }
      ]
    },
    {
      "id": "seed", "label": "Seed", "icon": "sparkle",
      "steps": [{ "label": "Seed", "run": "uv run python -m carli_platform.scripts.seed_local" }]
    },
    {
      "id": "ci", "label": "Check CI", "icon": "checklist",
      "inputs": { "suite": { "options": ["backend", "application", "api", "audit-auth", "solver", "frontend", "all"], "default": "backend" } },
      "env": { "MIGRATION_SMOKE_ADMIN_URL": "${db.url}" },
      "steps": [
        { "label": "Architecture", "run": "uv run python scripts/check_architecture.py" },
        { "label": "Lint", "run": "uv run ruff check backend scripts tests" },
        { "label": "Types (Python)", "run": "uv run pyright backend/carli_api" },
        { "label": "Frontend typecheck", "run": "npm run typecheck" },
        { "label": "Frontend tests", "run": "npm test" },
        { "label": "Frontend build", "run": "npm run build" },
        { "label": "Harness", "run": "uv run python scripts/ci/run_harness.py ${input:suite}" },
        { "label": "Database harness", "run": "uv run python scripts/ci/run_harness.py database" }
      ]
    }
  ]
}
```

### Sync Migrations

When a database got migrated from another branch, **Sync Migrations** puts it back:

1. For each stream, it reads the applied revisions (`versionQuery`) and the migration files of this
   branch (`versionsPath`). Applied revisions this branch doesn't have are foreign.
2. It finds the branch that added them (`git log -S`), reads that branch's files and follows
   `down_revision` back to the last revision this branch knows.
3. After you confirm, it checks that branch out into a temporary git worktree and runs
   `downgradeCommand` there with `${revision}` = that last known revision. Only the other
   branch's code can undo its own migrations. Your checkout isn't touched; the worktree is
   removed afterwards.
4. It runs this branch's `migrations.command`.

List the streams in the order they should be reverted (for Alembic with two streams: the one that
depends on the other first). In the example, `UV_PROJECT_ENVIRONMENT` makes the worktree reuse the
main checkout's virtualenv instead of creating a new one.

## Development

| Command | What it does |
|---|---|
| `npm run compile` | Type-check, lint, bundle the extension and the sidebar |
| `npm run test:unit` | Unit tests (Node, no VS Code), about a second |
| `npm test` | Integration tests in a downloaded VS Code, against `test/fixtures/workspace` |
| `npm run test:pg` | Opt-in tests against a real PostgreSQL server (see below) |

`test:pg` only creates and drops databases named `ap_selftest_*`:

```powershell
$env:AP_PG_ROOT = 'D:\code\carli'; $env:AP_PG_CONTAINER = 'carli-db-1'   # or AP_PG_SERVICE = 'db'
$env:AP_PG_COPY_MAIN = '1'   # optional: also pg_dump the main database (read-only) into a scratch copy
npm run test:pg
```

Press **F5** and pick **Run Extension on ../carli** to try it on a project.

### Layout

- `src/core/`: all logic, no `vscode` imports (settings, URLs, names, env building, branch rules,
  Postgres, script runner, the `Controller` with every user flow).
- `src/vscode/`: thin VS Code adapters (dialogs, git, tasks, terminals/debug env, settings,
  sidebar, status bar).
- `src/webview/`: sidebar UI. `render.ts` is a pure state → HTML function.
- `src/shared/protocol.ts`: messages between the extension and the sidebar.

## License

[MIT](LICENSE.md)
