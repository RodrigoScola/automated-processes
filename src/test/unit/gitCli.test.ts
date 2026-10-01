import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitCli } from '../../core/gitCli';
import { runProcess } from '../../core/process';
import { migration } from './migrationSync.test';

const identity = {
	GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
	GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
};

suite('GitCli (real git repository)', function () {
	this.timeout(30_000);
	let root: string;
	let git: GitCli;

	async function run(...args: string[]) {
		const result = await runProcess({ command: 'git', args, cwd: root, env: { ...process.env, ...identity } });
		assert.strictEqual(result.code, 0, `git ${args.join(' ')}: ${result.stderr}`);
		return result.stdout;
	}
	function write(file: string, text: string) {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), text);
	}

	suiteSetup(async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-git-'));
		await run('init', '-q', '-b', 'main');
		write('db/versions/a1.py', migration('a1', null));
		write('db/versions/a2.py', migration('a2', 'a1'));
		write('README.md', 'not a migration');
		await run('add', '.');
		await run('commit', '-q', '-m', 'base');
		await run('checkout', '-q', '-b', 'other');
		write('db/versions/o1.py', migration('o1', 'a2'));
		await run('add', '.');
		await run('commit', '-q', '-m', 'o1');
		write('db/versions/o2.py', migration('o2', 'o1'));
		await run('add', '.');
		await run('commit', '-q', '-m', 'o2');
		await run('checkout', '-q', 'main');
		await run('checkout', '-q', '-b', 'feature');
		write('db/versions/__pycache__/a1.cpython-312.pyc', 'binary');
		write('db/versions/new_untracked.py', migration('n1', 'a2'));
		git = new GitCli(root);
	});

	suiteTeardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('lists files in the working tree (including untracked, skipping caches) and at a ref', async () => {
		assert.deepStrictEqual((await git.listFiles('db/versions')).sort(), ['db/versions/a1.py', 'db/versions/a2.py', 'db/versions/new_untracked.py']);
		assert.deepStrictEqual((await git.listFiles('db/versions', 'other')).sort(), ['db/versions/a1.py', 'db/versions/a2.py', 'db/versions/o1.py', 'db/versions/o2.py']);
	});

	test('reads files from the working tree and from another branch', async () => {
		assert.match(await git.readFile('db/versions/a2.py'), /revision = "a2"/);
		assert.match(await git.readFile('db/versions/o2.py', 'other'), /down_revision = "o1"/);
		await assert.rejects(git.readFile('db/versions/o2.py', 'main'));
	});

	test('finds the branch that added a revision', async () => {
		assert.deepStrictEqual(await git.branchesContaining('o2', 'db/versions'), ['other']);
		assert.deepStrictEqual((await git.branchesContaining('a1', 'db/versions')).sort(), ['feature', 'main', 'other']);
		assert.deepStrictEqual(await git.branchesContaining('nowhere123', 'db/versions'), []);
	});

	test('adds and removes a temporary worktree of another branch', async () => {
		const folder = await git.addWorktree('other');
		try {
			assert.ok(fs.existsSync(path.join(folder, 'db/versions/o2.py')));
			assert.ok(!fs.existsSync(path.join(root, 'db/versions/o2.py')), 'the main checkout is untouched');
		} finally {
			await git.removeWorktree(folder);
		}
		assert.ok(!fs.existsSync(folder));
		assert.doesNotMatch(await run('worktree', 'list'), /automated-processes-/);
	});

	test('local branches and merged branches', async () => {
		const branches = await git.localBranches();
		assert.deepStrictEqual([...branches.keys()].sort(), ['feature', 'main', 'other']);
		assert.ok((await git.mergedInto('main')).has('feature'));
		assert.ok(!(await git.mergedInto('main')).has('other'));
	});
});
