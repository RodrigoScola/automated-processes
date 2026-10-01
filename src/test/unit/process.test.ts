import * as assert from 'assert';
import { pipeProcesses, runProcess } from '../../core/process';

const node = process.execPath;

suite('process', () => {
	test('captures stdout, stderr, exit code and stdin', async () => {
		const result = await runProcess({
			command: node,
			args: ['-e', 'process.stdin.on("data", d => process.stdout.write(String(d).toUpperCase())); process.stderr.write("warn"); process.stdin.on("end", () => process.exit(3))'],
			input: 'hello',
		});
		assert.deepStrictEqual(result, { code: 3, stdout: 'HELLO', stderr: 'warn' });
	});

	test('passes env and cwd', async () => {
		const result = await runProcess({
			command: node,
			args: ['-e', 'process.stdout.write(process.env.AP_TEST + "|" + process.cwd())'],
			env: { ...process.env, AP_TEST: 'yes' },
			cwd: __dirname,
		});
		assert.strictEqual(result.stdout, `yes|${__dirname}`);
	});

	test('explains a missing command', async () => {
		await assert.rejects(runProcess({ command: 'definitely-not-a-real-command-ap', args: [] }), /was not found/);
	});

	test('pipes one process into another', async () => {
		const { from, to } = await pipeProcesses(
			{ command: node, args: ['-e', 'process.stdout.write("a".repeat(200000)); process.stderr.write("dumped")'] },
			{ command: node, args: ['-e', 'let n = 0; process.stdin.on("data", d => n += d.length); process.stdin.on("end", () => { process.stdout.write(String(n)); process.exit(n === 200000 ? 0 : 5); })'] },
		);
		assert.strictEqual(from.code, 0);
		assert.strictEqual(from.stderr, 'dumped');
		assert.strictEqual(to.code, 0);
		assert.strictEqual(to.stdout, '200000');
	});

	test('pipe reports exit codes of both sides', async () => {
		const { from, to } = await pipeProcesses(
			{ command: node, args: ['-e', 'process.exit(4)'] },
			{ command: node, args: ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'] },
		);
		assert.strictEqual(from.code, 4);
		assert.strictEqual(to.code, 0);
	});

	test('pipe rejects when a command is missing', async () => {
		await assert.rejects(
			pipeProcesses({ command: 'definitely-not-a-real-command-ap', args: [] }, { command: node, args: ['-e', 'process.stdin.resume()'] }),
			/was not found/,
		);
	});
});
