# Change Log

All notable changes to the "automated-processes" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Initial release
- Security: the database password is no longer on the `docker` command line; Docker container and
  service names are validated (they were run through a shell); debug sessions of other folders
  in a multi-root workspace no longer get this folder's env file. See [SECURITY-REPORT.md](SECURITY-REPORT.md).
- **Configure** panel (gear in the sidebar): edit the database connection, servers and scripts
  with forms. Saved in the extension's workspace storage, overriding settings.json; a typed
  connection URL goes to VS Code's secret storage.
- SQLite support (`database.engine`, `database.sqliteFolder`): per-branch databases are file copies.
- launch.json `launch` configurations show up as servers, listed first
  (`server.includeLaunchConfigurations`).
- The sidebar lists only the main and current database, with **Show all databases** for the rest.
- The sidebar is four resizable, collapsible views: Database, Servers, Scripts and Settings.
- Scripts and servers run in background terminals without taking focus (`revealTerminal`).
- Configure panel: **Save for** this workspace or all workspaces; **Add defaults** detects servers,
  scripts and migrations from package.json, Python projects and launch.json; launch.json
  configurations are added one by one (**Add as server**; `server.includeLaunchConfigurations`
  now defaults to off); a Migrations section for Run Migrations and Sync Migrations.
- Servers, scripts and migrations can run in a subfolder (`cwd`, `migrations.cwd`).
- **Backup**, **Export Data** (to a database or a file) and **Import Data** (from a database or a
  file, backing the target up first). Backups go outside the repository (`database.backupFolder`).
- Scripts can run on VS Code startup, branch change, new commits or file save (`runOn`); servers
  can start with VS Code (`runOnStartup`). The "update dependencies automatically" setting moved
  into the script (`onGitUpdate` settings are still read).
- Scripts and servers run without a database connection; a project without a database (no
  `.env` or no URL) shows "No database connection" instead of a settings problem.
- After an update, every sidebar view is shown once, so a layout VS Code remembered from older
  versions can't keep the new views hidden.
- "Docker isn't running" has a **Start Docker** button: it launches Docker Desktop, waits for it,
  then reconnects (and starts the database container).
- Debugging a server gives focus back to the Servers view half a second after the launch (and
  after its terminal opens).
- Icon picker with search over every codicon; the Migrations card folds away until it's set up.
- New settings: `loadEnvFileIntoTerminals`, `applyToDebugSessions`, `echoCommands`,
  `database.autoStartContainer`, `database.warnIfPortExposed` (warns when the database container
  is reachable from the network).