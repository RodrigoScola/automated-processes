import * as assert from 'assert';
import { databasesFreeAfterUnlink, findFinishedLinks, isMainBranch, resolveCurrent } from '../../core/branches';
import { BranchLink, BranchStore, MemoryKeyValueStore } from '../../core/store';

suite('store', () => {
	const now = () => new Date('2026-10-01T10:00:00Z');

	test('links, unlinks and finds branches of a database', async () => {
		const store = new BranchStore(new MemoryKeyValueStore(), now);
		await store.link('a', 'db_a', 'c1');
		await store.link('b', 'db_a');
		assert.deepStrictEqual(store.linkOf('a'), { database: 'db_a', linkedAt: '2026-10-01T10:00:00.000Z', linkedAtCommit: 'c1' });
		assert.deepStrictEqual(store.branchesOf('db_a'), ['a', 'b']);
		await store.unlink('a');
		assert.strictEqual(store.linkOf('a'), undefined);
	});

	test('setCurrent remembers the previous database', async () => {
		const store = new BranchStore(new MemoryKeyValueStore(), now);
		assert.strictEqual(await store.setCurrent('main'), true);
		assert.strictEqual(store.data().previous, undefined);
		assert.strictEqual(await store.setCurrent('main'), false);
		await store.setCurrent('db_a');
		assert.strictEqual(store.data().previous, 'main');
		await store.setCurrent('main');
		assert.strictEqual(store.data().previous, 'db_a');
	});

	test('meta updates merge and forgetDatabase removes every trace', async () => {
		const store = new BranchStore(new MemoryKeyValueStore(), now);
		await store.updateMeta('db_a', { createdAt: 'x' });
		await store.updateMeta('db_a', { lastCopiedFrom: 'main' });
		assert.deepStrictEqual(store.meta('db_a'), { createdAt: 'x', lastCopiedFrom: 'main' });
		await store.link('a', 'db_a');
		await store.setCurrent('db_a');
		await store.setCurrent('main');
		await store.forgetDatabase('db_a');
		assert.deepStrictEqual(store.data().links, {});
		assert.deepStrictEqual(store.meta('db_a'), {});
		assert.strictEqual(store.data().previous, undefined);
	});

	test('data() returns copies', async () => {
		const store = new BranchStore(new MemoryKeyValueStore(), now);
		store.data().links.x = { database: 'y', linkedAt: '' };
		assert.deepStrictEqual(store.data().links, {});
	});
});

suite('branches', () => {
	const link = (database: string, linkedAtCommit?: string): BranchLink => ({ database, linkedAt: '', linkedAtCommit });

	test('isMainBranch', () => {
		assert.ok(isMainBranch('staging', ['staging']));
		assert.ok(!isMainBranch('feature', ['staging']));
		assert.ok(!isMainBranch(undefined, ['staging']));
	});

	test('resolveCurrent uses the link, else main', () => {
		const links = { a: link('db_a'), m: link('app') };
		assert.deepStrictEqual(resolveCurrent('a', links, 'app'), { database: 'db_a', isMain: false, linked: true });
		assert.deepStrictEqual(resolveCurrent('m', links, 'app'), { database: 'app', isMain: true, linked: true });
		assert.deepStrictEqual(resolveCurrent('other', links, 'app'), { database: 'app', isMain: true, linked: false });
		assert.deepStrictEqual(resolveCurrent(undefined, links, 'app'), { database: 'app', isMain: true, linked: false });
	});

	const base = {
		currentBranch: 'current',
		mainBranches: ['staging'],
		mainName: 'app',
	};

	test('finds deleted branches and branches merged after moving', () => {
		const result = findFinishedLinks({
			...base,
			links: {
				gone: link('db_gone', 'c0'),
				merged: link('db_merged', 'c1'),
				fresh: link('db_fresh', 'c2'),
				unmerged: link('db_unmerged', 'c3'),
				legacy: link('db_legacy'),
			},
			localBranches: new Set(['merged', 'fresh', 'unmerged', 'legacy', 'staging', 'current']),
			mergedBranches: new Set(['merged', 'fresh', 'legacy', 'staging']),
			tips: { merged: 'c9', fresh: 'c2', unmerged: 'c8', legacy: 'c7' },
		});
		assert.deepStrictEqual(result, [
			{ branch: 'gone', database: 'db_gone', reason: 'deleted' },
			{ branch: 'merged', database: 'db_merged', reason: 'merged' },
			{ branch: 'legacy', database: 'db_legacy', reason: 'merged' },
		]);
	});

	test('never returns the current branch, main branches or links to main', () => {
		const result = findFinishedLinks({
			...base,
			links: { current: link('db_c', 'a'), staging: link('db_s', 'b'), toMain: link('app', 'c') },
			localBranches: new Set(),
			mergedBranches: new Set(),
			tips: {},
		});
		assert.deepStrictEqual(result, []);
	});

	test('databases still linked by another branch are not freed', () => {
		const links = { a: link('shared'), b: link('shared'), c: link('own') };
		const free = databasesFreeAfterUnlink(
			[{ branch: 'a', database: 'shared', reason: 'merged' }, { branch: 'c', database: 'own', reason: 'deleted' }],
			links,
		);
		assert.deepStrictEqual(free, ['own']);
	});
});
