# Security report: leaks and risky defaults

Review of the whole extension (`src/`, `package.json`, build scripts), 2026-10-08. The question:
can the extension leak secrets or expose data, now or after a later configuration change, with a
focus on Docker?

**Short answer:** there's no malicious or hidden behavior. The extension makes no network calls,
sends no telemetry and doesn't use `eval`. It only starts `git`, `docker`, `psql`, `pg_dump`,
`pg_restore` and the commands you configure. There were, however, a few ways secrets or the
database could leak. Three of them are fixed outright. Five others are now settings, all
defaulting to the old behavior, so nothing changes until you flip them.

## Fixed

These had no upside, so they were fixed rather than made optional.

| # | Severity | What leaked | Where | Fix |
|---|---|---|---|---|
| 1 | Medium | **Database password on the `docker` command line.** In Docker mode every `psql` / `pg_dump` / `pg_restore` call ran `docker exec -e PGPASSWORD=<password> …`. Any process on the machine can read command lines (Task Manager's command-line column, `Get-CimInstance Win32_Process`, `ps`), and process-auditing / antivirus tools log them. | `src/core/postgres.ts`, `clientSpec` | It now passes `-e PGPASSWORD` with no value, and the password goes into the `docker` process's own environment, which Docker copies into the container. |
| 2 | Medium | **Shell injection through the container name.** **Start Database** (and the auto-start on startup) built `docker start <name>` / `docker compose up … <name>` and ran it through a shell. A `.vscode/settings.json`, for example one arriving with a `git pull`, could set `database.dockerContainer` to `db & curl … \| sh` and run anything. A name starting with `-` also turned into a `docker` flag. | `src/core/controller.ts`, `startDatabase`; `src/core/config.ts` | `database.dockerContainer` and `database.dockerComposeService` only accept Docker's name characters (letters, digits, `_`, `.`, `-`, starting with a letter or digit). Anything else is ignored and shown under "Settings need attention". |
| 3 | Low | **Env file sent to other projects' debug sessions.** In a multi-root workspace, launches from *other* folders also got this folder's `.env` values. | `src/vscode/environment.ts` | Only launches from the extension's own folder (or from the `.code-workspace` file) get them. |

> **To check after the first run with Docker:** #1 is covered by unit tests, but Docker wasn't
> running during the review, so it hasn't been run against a real container. Plain
> `docker exec -e NAME` copying the value from the CLI's environment is documented Docker
> behavior. `docker compose exec -e NAME` should do the same. If the database list loads in the
> sidebar, it works. If a Compose setup starts failing with `password authentication failed` or
> `no password supplied`, that's this change.

## New settings

Defaults keep the previous behavior. The last column says what to do if you want the stricter
setup.

| Setting | Default | The leak it controls | Stricter |
|---|---|---|---|
| `loadEnvFileIntoTerminals` | `true` | Every value in `.env` (API keys, passwords, tokens) goes into **every new terminal and debug session**. Every program started there can read them, including the install scripts of npm/pip packages, which is a common way supply-chain malware steals secrets. | `false`: terminals and debug sessions only get the database URL variables and `env`. Scripts, migrations and servers still get the whole file (`loadEnvFileIntoCommands`). |
| `applyToDebugSessions` | `true` | Debug launches get the variables and **override the launch configuration's `envFile`**. A test launch that reads `DATABASE_URL` from `.env.test` then runs against your dev database. | `false` if a launch configuration must keep its own values. Keep `true` if you rely on F5 using the branch database. |
| `echoCommands` | `true` | The command line printed at the top of each task terminal has placeholders filled in: `${db.url}` becomes the URL **with the password**, and `${env:SECRET}` becomes the secret. It shows up in screen shares, recordings and pasted logs. | `false`, or better, see "Placeholders in commands" below. |
| `database.autoStartContainer` | `true` | When VS Code opens (and on **Retry**), a stopped database container is started without asking (`docker start` / `docker compose up --detach --wait`). If its port is published on all interfaces, the database, which holds copies of your data, is on the network every time you open the project. `compose up` also recreates the container when the Compose file changed. | `false`: only the **Start Database** button starts it. |
| `database.warnIfPortExposed` | `true` (new check) | A sidebar warning when the container publishes its port on `0.0.0.0` or `[::]`, where other machines on the network (café Wi-Fi, office LAN) can reach it. On Linux, Docker's published ports also get around `ufw`. | Keep it on. Fix the cause in the Compose file: `ports: ["127.0.0.1:5432:5432"]`. |

The strictest setup, in user settings:

```jsonc
{
  "automatedProcesses.loadEnvFileIntoTerminals": false,
  "automatedProcesses.echoCommands": false,
  "automatedProcesses.database.autoStartContainer": false
}
```

## Unchanged, worth knowing

- **Workspace settings run commands.** `scripts`, `migrations.command`, `servers`, the streams'
  `downgradeCommand` and `onGitUpdate.script` are shell commands. If they live in a project's
  `.vscode/settings.json`, whoever can commit to that file can run code on your machine.
  `onGitUpdate.mode` defaults to `always`, so a pull that sets `onGitUpdate.script` runs it on
  the next pull without asking. Safeguard: the extension declares no support for untrusted
  workspaces, so VS Code keeps it off in Restricted Mode. If the project's settings are shared,
  consider `"automatedProcesses.onGitUpdate.mode": "ask"`.
- **Placeholders in commands.** Even with `echoCommands` off, a `run` command containing
  `${db.url}` is visible in the process list while it runs. Put secrets in a script's `env`
  instead (`"env": { "SMOKE_URL": "${db.url}" }`) and read the variable in the command. Values in
  `env` are neither printed nor on a command line.
- **Sync Migrations runs another branch's code**, possibly a teammate's remote branch, in a
  temporary checkout. It runs with your database URL and, with `loadEnvFileIntoCommands`, every
  `.env` value. It asks every time and names the branch, so read that name before confirming.
  If VS Code crashes mid-run, the checkout stays in your temp folder.
- **The extension acts on whatever server `DATABASE_URL` points at.** It creates and drops
  databases there. **Disconnect and Copy** and every drop (`DROP DATABASE … WITH (FORCE)`) end
  other sessions. Only point it at a local development server, never a shared or remote one.

### Not leaks, but destructive

- `database.onBranchMerged` defaults to `delete`: a finished branch's database is **dropped
  without asking**, 3 seconds after a git change or on startup. Branches also look finished when
  renamed (`git branch -m`) or when the repository is cloned again into the same folder. Hand-linked
  databases (**Switch Database**) are dropped too. Set it to `keep` if that's a concern.
- After **Sync Migrations**, `git worktree prune` also removes the records of any of your own
  worktrees whose folder is currently missing (e.g. on an unplugged drive).

## Checked and fine

- No network access, telemetry or dynamic code. Runtime dependencies are `dotenv` (only
  `parse()`), `@vscode-elements/elements` and `@vscode/codicons`.
- The sidebar webview has a strict Content Security Policy (scripts by nonce only) and escapes
  every value it renders.
- Terminal variables are not persisted (`environmentVariableCollection.persistent = false`), so
  `.env` values aren't written to VS Code's storage. Branch links in workspace storage hold no
  secrets.
- Postgres tools and `git` start without a shell, with argument lists. SQL names and values are
  quoted, so database and branch names can't inject anything.
- Without Docker, the password goes through `PGPASSWORD` in the environment, not the command line.
- Error messages show the tools' error output, never URLs or passwords. The sidebar and status
  bar show database names only.
