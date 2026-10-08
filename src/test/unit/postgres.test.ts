import * as assert from 'assert';
import {
	alterDatabaseSetSql,
	ClientSettings,
	clientSpec,
	describeFailure,
	FIELD_SEPARATOR,
	isTemplateInUse,
	parseExposedAddresses,
	parseRows,
	PostgresEngine,
	psqlArgs,
	quoteIdent,
	quoteLiteral,
	SQL,
} from '../../core/postgres';
import { ProcessResult, ProcessSpec } from '../../core/process';

const docker: ClientSettings = { user: 'app', password: 'pw', host: '127.0.0.1', port: 5433, dockerComposeService: 'db', cwd: '/repo', processEnv: { PATH: '/bin' } };
const local: ClientSettings = { ...docker, dockerComposeService: undefined };

suite('postgres SQL', () => {
	test('quotes identifiers and literals', () => {
		assert.strictEqual(quoteIdent('a"b'), '"a""b"');
		assert.strictEqual(quoteLiteral("o'clock"), "'o''clock'");
	});

	test('builds statements with quoted names', () => {
		assert.strictEqual(SQL.createFromTemplate('new', 'old'), 'CREATE DATABASE "new" TEMPLATE "old"');
		assert.strictEqual(SQL.drop('x'), 'DROP DATABASE IF EXISTS "x" WITH (FORCE)');
		assert.match(SQL.connections("it's"), /datname = 'it''s'/);
		assert.match(SQL.terminate('db'), /pg_terminate_backend/);
	});

	test('copies database settings, quoting scalars but not lists', () => {
		assert.strictEqual(alterDatabaseSetSql('t', 'TimeZone=Europe/London'), 'ALTER DATABASE "t" SET TimeZone TO \'Europe/London\'');
		assert.strictEqual(alterDatabaseSetSql('t', 'search_path=app, public'), 'ALTER DATABASE "t" SET search_path TO app, public');
		assert.strictEqual(alterDatabaseSetSql('t', 'garbage'), undefined);
		assert.strictEqual(alterDatabaseSetSql('t', 'bad key;=1'), undefined);
	});

	test('parses psql rows', () => {
		assert.deepStrictEqual(parseRows(`a${FIELD_SEPARATOR}b\r\nc${FIELD_SEPARATOR}d\n\n`), [['a', 'b'], ['c', 'd']]);
	});

	test('recognises a template in use', () => {
		assert.ok(isTemplateInUse(new Error('source database "app" is being accessed by other users')));
		assert.ok(!isTemplateInUse(new Error('other')));
		assert.ok(!isTemplateInUse('string'));
	});

	test('describes failures with the last stderr lines', () => {
		assert.strictEqual(describeFailure('psql', { code: 2, stdout: '', stderr: 'a\nb\nc\nd\n' }), 'psql failed (exit code 2): b c d');
		assert.strictEqual(describeFailure('psql', { code: 1, stdout: '', stderr: '' }), 'psql failed (exit code 1).');
	});
});

suite('postgres client commands', () => {
	test('docker mode runs the tool inside the service with the password', () => {
		const spec = clientSpec(docker, 'psql', ['-c', 'select 1']);
		assert.strictEqual(spec.command, 'docker');
		assert.deepStrictEqual(spec.args, ['compose', 'exec', '-T', '-e', 'PGPASSWORD', 'db', 'psql', '-U', 'app', '-c', 'select 1']);
		assert.strictEqual(spec.cwd, '/repo');
		assert.strictEqual(spec.env?.PGPASSWORD, 'pw');
		assert.strictEqual(spec.env?.PATH, '/bin');
	});

	test('container mode uses docker exec -i, like `docker exec -it carli-db-1 psql`', () => {
		const spec = clientSpec({ ...docker, dockerContainer: 'carli-db-1' }, 'psql', ['-d', 'automated']);
		assert.strictEqual(spec.command, 'docker');
		assert.deepStrictEqual(spec.args, ['exec', '-i', '-e', 'PGPASSWORD', 'carli-db-1', 'psql', '-U', 'app', '-d', 'automated']);
		assert.strictEqual(spec.env?.PGPASSWORD, 'pw');
	});

	test('the password is never on a docker command line', () => {
		for (const settings of [docker, { ...docker, dockerContainer: 'c1' }]) {
			const spec = clientSpec({ ...settings, password: 's3cr3t' }, 'pg_dump', ['-d', 'app']);
			assert.ok(!spec.args.some((arg) => arg.includes('s3cr3t')), spec.args.join(' '));
		}
	});

	test('a container takes precedence over a Compose service', () => {
		const spec = clientSpec({ ...docker, dockerContainer: 'c1', password: '' }, 'pg_restore', []);
		assert.deepStrictEqual(spec.args, ['exec', '-i', 'c1', 'pg_restore', '-U', 'app']);
	});

	test('docker mode without a password skips -e', () => {
		const spec = clientSpec({ ...docker, password: '' }, 'pg_dump', []);
		assert.deepStrictEqual(spec.args, ['compose', 'exec', '-T', 'db', 'pg_dump', '-U', 'app']);
		assert.ok(!('PGPASSWORD' in (spec.env ?? {})));
	});

	test('finds ports published on every interface', () => {
		const output = '5432/tcp -> 0.0.0.0:5432\r\n5432/tcp -> [::]:5432\n6379/tcp -> 127.0.0.1:6379\n';
		assert.deepStrictEqual(parseExposedAddresses(output), ['0.0.0.0:5432', '[::]:5432']);
		assert.deepStrictEqual(parseExposedAddresses('5432/tcp -> 127.0.0.1:5433\n'), []);
		assert.deepStrictEqual(parseExposedAddresses(''), []);
	});

	test('local mode passes host, port and PGPASSWORD', () => {
		const spec = clientSpec(local, 'pg_restore', ['-d', 'x']);
		assert.strictEqual(spec.command, 'pg_restore');
		assert.deepStrictEqual(spec.args, ['-h', '127.0.0.1', '-p', '5433', '-U', 'app', '-d', 'x']);
		assert.strictEqual(spec.env?.PGPASSWORD, 'pw');
		assert.strictEqual(spec.env?.PATH, '/bin');
	});

	test('psql arguments are quiet, unaligned and stop on error', () => {
		assert.deepStrictEqual(psqlArgs('postgres', 'SELECT 1'), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', FIELD_SEPARATOR, '-d', 'postgres', '-c', 'SELECT 1']);
	});
});

suite('PostgresEngine', () => {
	function engineWith(outputs: Record<string, ProcessResult>, pipeResult?: { from: ProcessResult; to: ProcessResult }) {
		const ran: ProcessSpec[] = [];
		const piped: [ProcessSpec, ProcessSpec][] = [];
		const engine = new PostgresEngine(
			docker,
			async (spec) => {
				ran.push(spec);
				const sql = spec.args[spec.args.length - 1];
				const key = Object.keys(outputs).find((prefix) => sql.startsWith(prefix));
				return key ? outputs[key] : { code: 0, stdout: '', stderr: '' };
			},
			async (from, to) => {
				piped.push([from, to]);
				return pipeResult ?? { from: { code: 0, stdout: '', stderr: '' }, to: { code: 0, stdout: '', stderr: '' } };
			},
		);
		return { engine, ran, piped };
	}

	test('lists databases from the maintenance database', async () => {
		const { engine, ran } = engineWith({ SELECT: { code: 0, stdout: 'app\napp_1\npostgres\n', stderr: '' } });
		assert.deepStrictEqual(await engine.listDatabases(), ['app', 'app_1', 'postgres']);
		assert.ok(ran[0].args.includes('postgres'));
	});

	test('maps connections', async () => {
		const row = ['42', 'uvicorn', '172.18.0.1', 'app', 'idle'].join(FIELD_SEPARATOR);
		const { engine } = engineWith({ SELECT: { code: 0, stdout: `${row}\n`, stderr: '' } });
		assert.deepStrictEqual(await engine.connections('app'), [{ pid: 42, application: 'uvicorn', client: '172.18.0.1', user: 'app', state: 'idle' }]);
	});

	test('terminate returns the count', async () => {
		const { engine } = engineWith({ SELECT: { code: 0, stdout: '3\n', stderr: '' } });
		assert.strictEqual(await engine.terminateConnections('app'), 3);
	});

	test('throws psql errors with stderr', async () => {
		const { engine } = engineWith({ CREATE: { code: 1, stdout: '', stderr: 'ERROR:  source database "app" is being accessed by other users\n' } });
		await assert.rejects(engine.createFromTemplate('x', 'app'), (error: Error) => isTemplateInUse(error));
	});

	test('copySettings applies every per-database setting', async () => {
		const { engine, ran } = engineWith({ SELECT: { code: 0, stdout: 'TimeZone=Europe/London\nsearch_path=a, b\n', stderr: '' } });
		await engine.copySettings('src', 'dst');
		const statements = ran.map((spec) => spec.args[spec.args.length - 1]).filter((sql) => sql.startsWith('ALTER'));
		assert.deepStrictEqual(statements, [
			'ALTER DATABASE "dst" SET TimeZone TO \'Europe/London\'',
			'ALTER DATABASE "dst" SET search_path TO a, b',
		]);
	});

	test('dumpRestore pipes pg_dump into pg_restore', async () => {
		const { engine, piped } = engineWith({});
		await engine.dumpRestore('src', 'dst');
		assert.strictEqual(piped.length, 1);
		assert.ok(piped[0][0].args.includes('pg_dump'));
		assert.deepStrictEqual(piped[0][0].args.slice(-2), ['-d', 'src']);
		assert.ok(piped[0][1].args.includes('pg_restore'));
		assert.deepStrictEqual(piped[0][1].args.slice(-2), ['-d', 'dst']);
	});

	test('dumpRestore reports which side failed', async () => {
		const failedDump = engineWith({}, { from: { code: 1, stdout: '', stderr: 'no such db' }, to: { code: 0, stdout: '', stderr: '' } });
		await assert.rejects(failedDump.engine.dumpRestore('a', 'b'), /pg_dump failed.*no such db/);
		const failedRestore = engineWith({}, { from: { code: 0, stdout: '', stderr: '' }, to: { code: 1, stdout: '', stderr: 'bad' } });
		await assert.rejects(failedRestore.engine.dumpRestore('a', 'b'), /pg_restore failed.*bad/);
	});

	test('exposedAddresses looks up the Compose container, then its published ports', async () => {
		const ran: string[] = [];
		const engine = new PostgresEngine(docker, async (spec) => {
			ran.push(spec.args.join(' '));
			return spec.args[0] === 'compose'
				? { code: 0, stdout: 'abc123\n', stderr: '' }
				: { code: 0, stdout: '5432/tcp -> 0.0.0.0:5433\n', stderr: '' };
		});
		assert.deepStrictEqual(await engine.exposedAddresses(), ['0.0.0.0:5433']);
		assert.deepStrictEqual(ran, ['compose ps -q db', 'port abc123']);
	});

	test('exposedAddresses is empty outside Docker and when docker fails', async () => {
		const failing = async () => ({ code: 1, stdout: '', stderr: 'boom' });
		assert.deepStrictEqual(await new PostgresEngine(local, failing).exposedAddresses(), []);
		assert.deepStrictEqual(await new PostgresEngine({ ...docker, dockerContainer: 'c1' }, failing).exposedAddresses(), []);
	});
});
