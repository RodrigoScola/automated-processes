import * as assert from 'assert';
import * as path from 'path';
import { ScriptDefinition } from '../../core/config';
import { RunState, ScriptRunner } from '../../core/scriptRunner';
import { FakeExecutor, FakeFiles } from './fakes';

const root = path.resolve('/repo');

const script: ScriptDefinition = {
	id: 'ci',
	label: 'Check CI',
	icon: 'checklist',
	env: {},
	inputs: { suite: { options: ['backend', 'all'], default: 'backend' } },
	steps: [
		{ label: 'Create .env', copyFile: { from: '.env.example', to: '.env', ifMissing: true } },
		{ label: 'Lint', run: 'ruff check' },
		{ label: 'Harness', run: 'run_harness ${input:suite} on ${db.name}' },
	],
};

function setup() {
	const executor = new FakeExecutor();
	const files = new FakeFiles();
	const states: RunState[] = [];
	let clock = 0;
	const runner = new ScriptRunner(executor, (state) => states.push(state), files, () => (clock += 10));
	const options = {
		env: { A: '1' },
		cwd: root,
		context: { env: {}, inputs: { suite: 'all' }, db: { name: 'app_1', url: 'u', mainName: 'app', mainUrl: 'm' } },
	};
	return { executor, files, states, runner, options };
}

suite('ScriptRunner', () => {
	test('runs every step in order with resolved commands', async () => {
		const { executor, files, runner, options } = setup();
		files.files.add(path.join(root, '.env.example'));
		const result = await runner.run(script, options);
		assert.strictEqual(result.status, 'passed');
		assert.deepStrictEqual(result.steps.map((step) => step.status), ['passed', 'passed', 'passed']);
		assert.deepStrictEqual(files.copies, [[path.join(root, '.env.example'), path.join(root, '.env')]]);
		assert.deepStrictEqual(executor.requests.map((request) => request.command), ['ruff check', 'run_harness all on app_1']);
		assert.strictEqual(executor.requests[0].name, 'Check CI › Lint');
		assert.deepStrictEqual(executor.requests[0].env, { A: '1' });
		assert.strictEqual(executor.requests[0].cwd, root);
	});

	test('skips copyFile when the target exists', async () => {
		const { files, runner, options } = setup();
		files.files.add(path.join(root, '.env.example'));
		files.files.add(path.join(root, '.env'));
		const result = await runner.run(script, options);
		assert.strictEqual(result.steps[0].status, 'skipped');
		assert.match(result.steps[0].detail ?? '', /already exists/);
		assert.strictEqual(files.copies.length, 0);
		assert.strictEqual(result.status, 'passed');
	});

	test('fails copyFile when the source is missing', async () => {
		const { runner, options } = setup();
		const result = await runner.run(script, options);
		assert.strictEqual(result.status, 'failed');
		assert.match(result.steps[0].detail ?? '', /not found/);
		assert.deepStrictEqual(result.steps.slice(1).map((step) => step.status), ['skipped', 'skipped']);
	});

	test('stops at the first failing command', async () => {
		const { executor, files, runner, options } = setup();
		files.files.add(path.join(root, '.env.example'));
		executor.exitCode = (request) => (request.command === 'ruff check' ? 2 : 0);
		const result = await runner.run(script, options);
		assert.strictEqual(result.status, 'failed');
		assert.deepStrictEqual(result.steps.map((step) => step.status), ['passed', 'failed', 'skipped']);
		assert.strictEqual(result.steps[1].detail, 'Exit code 2.');
		assert.strictEqual(executor.requests.length, 1);
	});

	test('a throwing executor marks the step failed', async () => {
		const { executor, runner, options } = setup();
		executor.runCommand = async () => {
			throw new Error('boom');
		};
		const result = await runner.run({ ...script, steps: [script.steps[1]] }, options);
		assert.strictEqual(result.steps[0].status, 'failed');
		assert.strictEqual(result.steps[0].detail, 'boom');
	});

	test('runs a single step', async () => {
		const { executor, runner, options } = setup();
		const result = await runner.run(script, { ...options, onlyStep: 2 });
		assert.strictEqual(result.label, 'Check CI › Harness');
		assert.deepStrictEqual(result.steps.map((step) => step.label), ['Harness']);
		assert.strictEqual(executor.requests.length, 1);
		await assert.rejects(runner.run(script, { ...options, onlyStep: 9 }), /has no step 9/);
	});

	test('reports progress and timestamps', async () => {
		const { files, states, runner, options } = setup();
		files.files.add(path.join(root, '.env.example'));
		await runner.run(script, options);
		assert.strictEqual(states[0].status, 'running');
		assert.deepStrictEqual(states[0].steps.map((step) => step.status), ['pending', 'pending', 'pending']);
		assert.ok(states.some((state) => state.steps[1].status === 'running'));
		const last = states[states.length - 1];
		assert.strictEqual(last.status, 'passed');
		assert.ok(last.finishedAt && last.finishedAt > last.startedAt);
		assert.ok(last.steps.every((step) => step.startedAt !== undefined && step.finishedAt !== undefined));
		assert.deepStrictEqual(runner.lastRun, last);
	});

	test('refuses to start while running and supports cancel', async () => {
		const { executor, runner, options } = setup();
		let release: (code: number) => void = () => undefined;
		executor.runCommand = (request) => {
			executor.requests.push(request);
			return new Promise((resolve) => (release = resolve));
		};
		const lint: ScriptDefinition = { ...script, steps: [script.steps[1], script.steps[2]] };
		const first = runner.run(lint, options);
		await new Promise((resolve) => setImmediate(resolve));
		assert.ok(runner.running);
		await assert.rejects(runner.run(lint, options), /still running/);
		runner.cancel();
		assert.ok(executor.cancelled);
		release(130);
		const result = await first;
		assert.strictEqual(result.status, 'cancelled');
		assert.deepStrictEqual(result.steps.map((step) => step.status), ['failed', 'skipped']);
		assert.strictEqual(executor.requests.length, 1);
	});
});
