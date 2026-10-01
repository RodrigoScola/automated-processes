# Automated Processes

A VS Code extension that gives each git branch its own PostgreSQL database and turns project
scripts into sidebar buttons. It knows nothing about any particular project: everything
project-specific is a VS Code setting (`automatedProcesses.*`).

- **Per-branch databases.** `New Database` copies the main database for the current branch and
  runs migrations on it. Switching branches switches the database. **Export Data** copies any
  database into any other. Databases of merged branches are dropped (or kept, by setting).
- **No `.env` editing.** The current database is passed to scripts, new terminals and debug
  sessions as environment variables, which override `.env` in most frameworks.
- **Works on Windows.** With `loadEnvFileIntoCommands` (on by default), every value from `.env` is
  passed to commands, for tools that only read real environment variables.
- **Script buttons.** Steps run one after another as VS Code tasks and stop at the first
  failure. The sidebar shows each step's state.

The design and decisions are in [PLAN.md](PLAN.md).

## Requirements

- PostgreSQL, either in Docker (`database.dockerContainer` or `database.dockerComposeService`; nothing to
  install locally) or with `psql`, `pg_dump` and `pg_restore` on PATH.
- The user in the database URL needs the `CREATEDB` permission.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `envFile` | `.env` | Env file with the database URL (read only) |
| `loadEnvFileIntoCommands` | `true` | Pass env file values to every command |
| `env` | `{}` | Extra variables for every command (placeholders allowed) |
| `applyToTerminals` | `true` | Current database in new terminals |
| `database.urlVariables` | `["DATABASE_URL"]` | Variables pointed at the current database; the first defines main |
| `database.mainBranches` | `["main"]` | Branches that use the main database |
| `database.dockerContainer` | `""` | Run Postgres tools in this container (`docker exec`) |
| `database.dockerComposeService` | `""` | Or in this Compose service (`docker compose exec`) |
| `database.hidePatterns` | `["postgres"]` | Databases hidden from the list (globs) |
| `database.newNamePattern` | `{main}_{branchShort}` | Suggested new database name (`{main}`, `{branch}`, `{branchShort}`, `{issue}`) |
| `database.importDataOnCreate` | `true` | New Database imports the main database (schema and data); off = empty database + migrations |
| `database.onBranchMerged` | `delete` | `delete` or `keep` databases of merged/deleted branches |
| `testDatabase.envFile` | `""` | Env file with the test URL (empty = `envFile`) |
| `testDatabase.urlVariables` | `[]` | Variables pointed at the per-branch test database |
| `testDatabase.nameSuffix` | `_test` | Test database = branch database + suffix |
| `migrations.command` | `""` | Command that applies migrations |
| `migrations.onBranchChange` | `ask` | `off` / `ask` / `always` |
| `migrations.afterCopy` | `true` | Run migrations after **Export Data** |
| `server.command` | `""` | Command that starts your server (Start/Stop/Restart in the sidebar) |
| `server.onDatabaseChange` | `restart` | `restart` / `ask` / `off`: restart the server and running debug sessions when the database changes |
| `scripts` | `[]` | Sidebar script buttons |

Placeholders in commands and `env`: `${db.name}`, `${db.url}`, `${db.mainName}`, `${db.mainUrl}`,
`${testDb.name}`, `${testDb.url}`, `${env:NAME}`, `${input:NAME}`, `${branch}`.

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
