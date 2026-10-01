# Plan: Automated Processes (VS Code extension)

> **Status (2026-10-01):** V1 implemented as planned. See [README.md](README.md) for settings and
> development commands. Tests: 129 unit, 4 VS Code integration, 6 real-PostgreSQL (opt-in).
> Changes from the plan: the activity bar icon is the rocket codicon copied to `media/icon.svg`;
> per-database settings (`ALTER DATABASE … SET`, e.g. `TimeZone`) are copied along with the data,
> because neither template copies nor dumps include them.

A general-purpose VS Code extension that:

1. Gives each git branch its own **PostgreSQL database** (and test database), so migrations
   from one branch don't leak into the database other branches use.
2. Runs **project scripts** (setup, seed, migrations, CI checks) from buttons, with the right
   environment on any OS.
3. Shows both in a **sidebar**.

Names: display name **Automated Processes**, command prefix `Automated Processes:`, command IDs
`automated-processes.*`, settings `automatedProcesses.*`.

## Decisions

| Topic | Decision |
|---|---|
| Name | Automated Processes |
| Project knowledge | None in the code. Everything project-specific is a VS Code setting. |
| Configuration | Normal VS Code settings: user settings, or the project's `.vscode/settings.json`, like any extension. Whether a project tracks that file in git is up to the project. |
| Memory (branch → database links, previous database) | Extension storage on your machine (`workspaceState`), personal, never shared |
| Previous database | Always remembered when the current database changes; one click switches back |
| New database | Copy of main (data included), then run migrations |
| Copying into main | Warning dialog ("You are copying into the main database. Are you sure?"); on yes, copy everything |
| Blocked copies | Decided below (see "Copy") |
| CI steps | Scripts stay simple; repeated steps are accepted |
| Test databases | Per branch: the extension points the test URL variables at `<branch db>_test`; the project's test suite creates and migrates it |
| Merged branch | Its databases are dropped once it's merged into a main branch (default); a setting keeps them instead |
| Existing databases | Not linked automatically; link by hand with `Switch Database` |
| Script types | V1: shell commands and file copy only |
| Icon | VS Code's `rocket` codicon |

## Principle: the extension knows nothing about any project

- No project names, paths, commands or variable names in the extension's code.
- The extension only knows generic things: git branches, env files, PostgreSQL, Docker Compose,
  VS Code tasks.
- The database layer sits behind an **engine adapter** interface. PostgreSQL is the only V1
  adapter.

---

## Configuration (VS Code settings)

All under `automatedProcesses.*`. Can be set in user settings or in a project's
`.vscode/settings.json`. Settings that hold lists or objects (`scripts`, `env`) are edited in
`settings.json`, like other extensions' complex settings.

| Setting | Default | Purpose |
|---|---|---|
| `envFile` | `.env` | Env file to read (never written) |
| `loadEnvFileIntoCommands` | `true` | Pass env file values to every command (needed on Windows when tools read only real environment variables) |
| `env` | `{}` | Extra variables for every command |
| `database.urlVariables` | `["DATABASE_URL"]` | Variables pointed at the **current** database. The first one gives the main database URL. |
| `database.mainBranches` | `["main"]` | Branches that use the main database |
| `database.dockerContainer` | `""` | If set, run `psql`/`pg_dump` inside this container (`docker exec`) |
| `database.dockerComposeService` | `""` | Or inside this Compose service (`docker compose exec`); neither = tools from PATH |
| `database.hidePatterns` | `["postgres"]` | Databases hidden from the list (globs) |
| `database.newNamePattern` | `{main}_{branchShort}` | Suggested name for new databases |
| `database.onBranchMerged` | `delete` | `delete` / `keep` the databases of branches merged into a main branch (or deleted) |
| `testDatabase.envFile` | `""` | Env file that holds the test URL (e.g. `.env.test`); empty = `envFile` |
| `testDatabase.urlVariables` | `[]` | Variables pointed at the current **test** database. Empty = test databases off. |
| `testDatabase.nameSuffix` | `_test` | Test database for `myapp_347` is `myapp_347_test` |
| `migrations.command` | `""` | Command that applies migrations to the current database |
| `migrations.onBranchChange` | `ask` | `off` / `ask` / `always` |
| `migrations.afterCopy` | `true` | Run migrations after `Migrate` |
| `applyToTerminals` | `true` | Put the current database in new terminals |
| `scripts` | `[]` | Script buttons (format below) |

### Script format

```jsonc
"automatedProcesses.scripts": [
  {
    "id": "setup",
    "label": "Setup",
    "icon": "tools",                      // any codicon name
    "env": {},                            // extra variables for this script
    "inputs": {                           // optional dropdowns in the sidebar
      "suite": { "options": ["a", "b"], "default": "a" }
    },
    "steps": [
      { "label": "Create .env", "copyFile": { "from": ".env.example", "to": ".env", "ifMissing": true } },
      { "label": "Install", "run": "npm ci" }
    ]
  }
]
```

### Placeholders (in commands and `env`)

| Placeholder | Value |
|---|---|
| `${db.name}`, `${db.url}` | current database |
| `${db.mainName}`, `${db.mainUrl}` | main database |
| `${testDb.name}`, `${testDb.url}` | current test database |
| `${env:NAME}` | a variable from the env file or your environment |
| `${input:NAME}` | a sidebar dropdown value |
| `${branch}` | current git branch |

---

## Part 1: Per-branch databases

### How it works

The **main database** belongs to `mainBranches`. Any other branch can have its own database.
The extension remembers which database goes with which branch. When you switch branches, that
branch's database becomes **current**, and everything the extension runs, plus new terminals
and debug sessions, uses it. **Env files are never changed.** Apps pick up the current database
because real environment variables override `.env` in most frameworks.

If `testDatabase.urlVariables` is set, every branch database has a matching test database
name (`<name><nameSuffix>`), and the test variables point at it (the URL is the one in
`testDatabase.envFile` with the name swapped). **The extension doesn't create or copy test
databases.** Test suites usually create and migrate their own (the example project's does), so
pointing the variable is enough. Keep `test` in the name: test suites often refuse to run
against a database without it.

### Commands

#### `New Database`

1. Ask for a name, suggested from `newNamePattern` (e.g. `myapp_347` from branch
   `347-fix-something`), kept within Postgres's 63-character limit.
2. Copy the main database into it (see "Copy").
3. Run `migrations.command` on it.
4. If test databases are on, point the test variables at `<name>_test` (created by the test suite
   on its first run).
5. Remember the previously current database, link the new one to this branch, make it current.

#### Switching branches (automatic)

- Branch change events come from VS Code's built-in Git extension.
- **Linked database:** becomes current. **Main branch:** main becomes current.
  **No database:** fall back to main and offer `New Database`.
- The previously current database is always remembered.
- **Run migrations on branch change** (`migrations.onBranchChange`).
  - **Safety rule:** if the current database is main and the branch isn't a main branch, it
    never runs automatically. It asks first and warns that this is the leak the extension exists
    to prevent.

#### `Migrate` (copy data)

1. Pick the **source** (default: main) and **target** (default: current) from the database list.
2. Confirm `source → target`; the target is replaced.
3. **If the target is main:** a modal warning, "You are copying into the main database. Are you
   sure?". On yes, copy everything.
4. Copy (see below), then run migrations if `migrations.afterCopy`.

#### Copy (used by New Database and Migrate)

1. **Fast path:** `DROP DATABASE IF EXISTS target WITH (FORCE)`, then
   `CREATE DATABASE target TEMPLATE source`. Takes seconds.
2. **If the source has other connections** (API server, DB GUI), the fast path is blocked.
   The extension shows a dialog listing them (app name, client), with:
   - **Disconnect and copy** (default): ends those sessions with `pg_terminate_backend`, then
     does the fast path. Apps reconnect on their next query.
   - **Copy without disconnecting:** `pg_dump source | pg_restore -d target`. Slower, and nothing
     gets interrupted.
   - **Cancel.**

#### Branch merged

Checked when the repository state changes (e.g. after a pull or fetch). A linked branch counts
as merged when `git branch --merged <main branch>` lists it, or when it no longer exists locally:
- `onBranchMerged: delete` (default): drop its database and its test databases
  (`<name>_test` and any `<name>_test_*` copies, such as parallel test workers), unlink it, and
  show a notification saying what was dropped.
- `keep`: just unlink it; the databases stay in the list.

Never dropped this way: the main database, and the database of the branch you're currently on.
That second rule also covers a brand-new branch with no commits yet, which git already lists as
"merged".

#### Smaller commands

- `Switch Database`: make any database current and link it to this branch.
- `Remove Database`: unlink and drop it (with confirmation).
- `Clean Up Databases`: drop databases matching patterns you choose (e.g. leftover test
  databases), with confirmation.

### Memory

`context.workspaceState`, on your machine, per workspace:

```json
{
  "previous": "myapp",
  "links": { "347-fix-something": "myapp_347" },
  "meta": { "myapp_347": { "createdAt": "…", "lastCopiedFrom": "myapp", "lastCopiedAt": "…" } }
}
```

The database list comes from the server (`pg_database`).

### Talking to Postgres

- `database.dockerContainer` set: run `psql`/`pg_dump`/`pg_restore` with
  `docker exec -i <container> …`. Nothing to install locally. If the container isn't running,
  offer to start it (`docker start`).
- `database.dockerComposeService` set (and no container): the same through
  `docker compose exec -T <service> …` (`docker compose up --wait` to start it).
- Otherwise: client tools from PATH.
- Credentials come from the main URL in the env file; the extension never stores them.

---

## Part 2: Scripts and environment

### The environment every command gets

1. Your normal environment.
2. All variables from `envFile` (if `loadEnvFileIntoCommands`).
3. `database.urlVariables` → current database URL; `testDatabase.urlVariables` → current test
   database URL.
4. `env` setting, then the script's own `env` (placeholders resolved).

Only the listed URL variables are overridden. Nothing else from the env file is changed.

Applied to:
- **Scripts** from the sidebar (task environment).
- **New VS Code terminals** (`environmentVariableCollection`, if `applyToTerminals`). Older
  terminals get VS Code's "relaunch" notice.
- **Debug sessions**: a debug configuration provider adds the URL variables to `env`, which
  VS Code applies over `envFile`.

### Running scripts

- Steps run one after another through the VS Code **Tasks API** (`ShellExecution`, working
  folder = workspace), each visible in a terminal. `onDidEndTaskProcess` gives the exit code;
  the first failure stops the script.
- Step types: `run` (shell command) and `copyFile` (works on every OS, unlike `cp`).
- A built-in **Run Migrations** button runs `migrations.command`.
- Any single step can be run on its own.

---

## Part 3: The sidebar

```
┌────────────────────────────────┐
│ AUTOMATED PROCESSES            │
├────────────────────────────────┤
│ DATABASE                       │
│ ┌────────────────────────────┐ │
│ │ ● myapp_347                │ │  current database
│ │   branch: 347-fix-somethi… │ │
│ │   test db: myapp_347_test  │ │
│ │   copied from myapp · 2 h  │ │
│ │   previous: myapp   [↩]    │ │  switch back
│ └────────────────────────────┘ │
│ [⇄ Migrate]  [＋ New Database]  │
│                                │
│ Databases                      │
│   ★ myapp          main        │
│   ● myapp_347      347-fix…    │
│     myapp_demo     not linked  │
│   ☐ show hidden (21)           │
├────────────────────────────────┤
│ SCRIPTS                        │  ← one button per configured script
│ [🔧 Setup]  [🌱 Seed]           │
│ [⬆ Run Migrations]             │
│ [✓ Check CI]  suite [backend▾] │
│                                │
│ Last run: Check CI · 1m 12s    │
│   ✔ Architecture               │
│   ✖ Types       ← open output  │
│   ○ Build                      │
├────────────────────────────────┤
│ migrate on branch change: ask ▾│
│ ⚙ Settings                     │
└────────────────────────────────┘
```

- **Top:** current database card (with test database and a "switch back to previous" button),
  Migrate / New Database, database list (★ main, ● current, hover for actions).
- **Bottom:** script buttons, input dropdowns, step-by-step state of the last run.
- **Footer:** "migrate on branch change" dropdown; ⚙ opens the extension's settings.
- **Status bar:** `$(database) myapp_347`.
- **Warnings:** container not running, branch using main, nothing configured yet.

### Making it look good

- One **Webview View**; tree views can't do cards, button rows or live progress.
- **VS Code theme variables** so it matches every theme.
- **`@vscode-elements/elements`** for native-looking controls, **Codicons** for icons.
- Spinner on the running step, colored state pills, relative times, helpful empty states.
- The webview only draws; logic stays in the extension (`postMessage` both ways).

### The icon

The **`rocket` codicon** from VS Code's own icon set. If the activity bar can't reference a
codicon by name (`$(rocket)`) in the targeted VS Code version, copy that icon's SVG from the
Codicons package (CC BY 4.0) into `media/icon.svg`. Swapping it for another codicon later only
changes the name.

---

## Code layout

```
src/
  extension.ts            activate: commands, sidebar, status bar, branch listener
  config.ts               read automatedProcesses.* settings, react to changes
  placeholders.ts         ${db.*}, ${testDb.*}, ${env:*}, ${input:*}, ${branch}
  git.ts                  current branch, change event, merged/deleted branches (vscode.git API)
  envFile.ts              parse env files
  environment.ts          build the command environment; terminals + debug provider
  store.ts                branch links, previous database, metadata
  db/
    engine.ts             adapter interface (list, create, copy, drop, connections)
    postgres.ts           PostgreSQL adapter
    clientRunner.ts       run client tools locally or via docker compose exec
  scripts/
    runner.ts             run steps as tasks, track state, stop on failure
  commands/
    newDatabase.ts
    migrate.ts
    manage.ts             switch, remove, clean up
    cleanupBranches.ts    merged branch handling
  sidebar/
    SidebarProvider.ts
webview/
  main.ts                 sidebar UI (second esbuild entry point)
  styles.css
media/
  icon.svg                activity bar icon (rocket codicon), only if $(rocket) isn't supported
```

## What to install

- `@vscode-elements/elements`: sidebar UI components.
- `@vscode/codicons`: icons.
- `dotenv`: only `parse()`, to read env files correctly.
- No database driver; Postgres tools run in the Docker container or from PATH.

---

## Appendix: example settings for your first project

These go in that project's `.vscode/settings.json` (or your user settings). They're an example
of the settings above, not part of the extension's code. Based on reading the project's repo on
2026-10-01:

- PostgreSQL 16 in Compose service `db`; tenants are schemas in one database, so a whole-database
  copy covers every tenant.
- The migration runner reads URLs from real environment variables only (the reason for the
  `$env:` lines on Windows); `loadEnvFileIntoCommands` replaces them.
- The app's settings let real environment variables override `.env`.
- The Compose file uses the `*_DB_NAME` variable for the container's own settings, so only the
  URL variables are overridden.
- Tests read `TEST_DATABASE_URL` from `.env.test`. The test fixtures
  (`tests/integration/carli_test_support/fixtures.py`) create the test database, install
  `pg_partman`, run both migration streams, and rebuild it when migrations change (a fingerprint
  is stored as a comment on the database). Parallel workers get their own `_gw0`… copies. So per
  branch, pointing `TEST_DATABASE_URL` at `simplecare_347_test` is enough. It also stops
  switching branches from forcing a test database rebuild every time.

```jsonc
{
  "automatedProcesses.envFile": ".env",
  "automatedProcesses.database.urlVariables": ["DATABASE_URL", "DATABASE_ADMIN_URL"],
  "automatedProcesses.database.mainBranches": ["staging"],
  "automatedProcesses.database.dockerContainer": "carli-db-1",
  "automatedProcesses.database.hidePatterns": ["postgres", "*_test", "*_test_gw*"],
  "automatedProcesses.database.newNamePattern": "{main}_{issue}",
  "automatedProcesses.testDatabase.envFile": ".env.test",
  "automatedProcesses.testDatabase.urlVariables": ["TEST_DATABASE_URL"],
  "automatedProcesses.migrations.command": "uv run python -m carli_core.migrations.runner",
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

---

## Open questions

None right now.
