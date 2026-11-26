const esbuild = require("esbuild");

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

async function main() {
	const ctx = await esbuild.context({
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
	// Code Memory 탭 화면 (웹뷰) — 개념 계산은 src/study.ts 를 같이 묶는다
	const web = await esbuild.context({
		entryPoints: ['src/web/hub.js'],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		target: 'es2020',
		outfile: 'dist/hub.js',
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});
	if (watch) {
		await ctx.watch();
		await web.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
		await web.rebuild();
		await web.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
