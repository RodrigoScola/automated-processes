import * as assert from 'assert';
import {
	buildGraph,
	DEFAULT_DOWN_REVISION_PATTERN,
	DEFAULT_REVISION_PATTERN,
	parseMigration,
	planRevert,
} from '../../core/migrationSync';

const patterns = { revision: DEFAULT_REVISION_PATTERN, downRevision: DEFAULT_DOWN_REVISION_PATTERN };

/** An Alembic-style migration file. */
export function migration(revision: string, down: string | string[] | null, annotated = false): string {
	const downText = down === null ? 'None' : Array.isArray(down) ? `(${down.map((item) => `"${item}"`).join(', ')})` : `"${down}"`;
	return [
		'"""add things',
		'',
		`Revision ID: ${revision}`,
		`Revises: ${Array.isArray(down) ? down.join(', ') : down ?? ''}`,
		'"""',
		'from alembic import op',
		'',
		annotated ? `revision: str = '${revision}'` : `revision = "${revision}"`,
		annotated ? `down_revision: Union[str, Sequence[str], None] = ${downText.replace(/"/g, '\'')}` : `down_revision = ${downText}`,
		'branch_labels = None',
		'',
		'def upgrade():',
		'    op.create_table("x")',
	].join('\n');
}

suite('migrationSync: parsing', () => {
	test('reads plain and annotated Alembic revisions', () => {
		assert.deepStrictEqual(parseMigration(migration('b2', 'b1'), patterns), { revision: 'b2', downRevisions: ['b1'] });
		assert.deepStrictEqual(parseMigration(migration('b2', 'b1', true), patterns), { revision: 'b2', downRevisions: ['b1'] });
	});

	test('reads merges and the first migration', () => {
		assert.deepStrictEqual(parseMigration(migration('m', ['a', 'b']), patterns), { revision: 'm', downRevisions: ['a', 'b'] });
		assert.deepStrictEqual(parseMigration(migration('first', null), patterns), { revision: 'first', downRevisions: [] });
	});

	test('ignores files without a revision (e.g. __init__.py, README)', () => {
		assert.strictEqual(parseMigration('# nothing here\nprint("hi")', patterns), undefined);
		assert.strictEqual(parseMigration('Revision ID: abc', patterns), undefined);
	});

	test('custom patterns', () => {
		const custom = { revision: String.raw`^-- id: (\S+)`, downRevision: String.raw`^-- parent: (.*)$` };
		assert.deepStrictEqual(parseMigration('-- id: 002\n-- parent: "001"\nCREATE TABLE x();', custom), { revision: '002', downRevisions: ['001'] });
	});

	test('buildGraph keys by revision', () => {
		const graph = buildGraph([migration('a', null), migration('b', 'a'), 'not a migration'], patterns);
		assert.deepStrictEqual([...graph.keys()], ['a', 'b']);
	});
});

suite('migrationSync: planning', () => {
	// Shared history: base ← a1 ← a2. This branch adds nothing; the other branch adds o1 ← o2 ← o3 on a2.
	const known = new Set(['base0', 'a1', 'a2']);
	const other = buildGraph([
		migration('base0', null), migration('a1', 'base0'), migration('a2', 'a1'),
		migration('o1', 'a2'), migration('o2', 'o1'), migration('o3', 'o2'),
	], patterns);

	test('in sync when every applied revision is known', () => {
		assert.deepStrictEqual(planRevert(['a2'], known, other), { status: 'in-sync' });
		assert.deepStrictEqual(planRevert([], known, other), { status: 'in-sync' });
	});

	test('walks back from a foreign head to the last known revision', () => {
		assert.deepStrictEqual(planRevert(['o3'], known, other), { status: 'revert', foreign: ['o3', 'o2', 'o1'], target: 'a2' });
	});

	test('reverts to base when nothing known is left', () => {
		const graph = buildGraph([migration('x1', null), migration('x2', 'x1')], patterns);
		assert.deepStrictEqual(planRevert(['x2'], new Set(['y']), graph), { status: 'revert', foreign: ['x2', 'x1'], target: 'base' });
	});

	test('follows merges', () => {
		const graph = buildGraph([migration('a2', 'a1'), migration('p', 'a2'), migration('q', 'a2'), migration('m', ['p', 'q'])], patterns);
		assert.deepStrictEqual(planRevert(['m'], known, graph), { status: 'revert', foreign: ['m', 'p', 'q'], target: 'a2' });
	});

	test('errors when the history is unknown or goes back to several known revisions', () => {
		const missing = planRevert(['zz'], known, other);
		assert.strictEqual(missing.status, 'error');
		const split = buildGraph([migration('p', 'a1'), migration('q', 'a2'), migration('m', ['p', 'q'])], patterns);
		const result = planRevert(['m'], known, split);
		assert.strictEqual(result.status, 'error');
		assert.match(result.status === 'error' ? result.message : '', /more than one revision/);
	});
});
