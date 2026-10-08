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
- New settings: `loadEnvFileIntoTerminals`, `applyToDebugSessions`, `echoCommands`,
  `database.autoStartContainer`, `database.warnIfPortExposed` (warns when the database container
  is reachable from the network).