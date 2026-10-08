const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

/** Copies the webviews' static files (styles and the codicon font) next to their bundles. */
function copyWebviewAssets() {
	const target = path.join(__dirname, 'dist', 'webview');
	fs.mkdirSync(target, { recursive: true });
	const codicons = path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist');
	for (const [from, name] of [
		[path.join(__dirname, 'src', 'webview', 'styles.css'), 'styles.css'],
		[path.join(__dirname, 'src', 'webview', 'panel.css'), 'panel.css'],
		[path.join(codicons, 'codicon.css'), 'codicon.css'],
		[path.join(codicons, 'codicon.ttf'), 'codicon.ttf'],
	]) {
		fs.copyFileSync(from, path.join(target, name));
	}
}

async function main() {
	copyWebviewAssets();
	const extension = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});
	const webview = await esbuild.context({
		entryPoints: { main: 'src/webview/main.ts', panel: 'src/webview/panel.ts' },
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		target: 'es2022',
		outdir: 'dist/webview',
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});
	if (watch) {
		await extension.watch();
		await webview.watch();
	} else {
		await extension.rebuild();
		await webview.rebuild();
		await extension.dispose();
		await webview.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
