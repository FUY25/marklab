import esbuild from 'esbuild';
import process from 'node:process';

const mode = process.argv[2] ?? 'production';
const watch = process.argv.includes('--watch');
const production = mode === 'production';

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian'],
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  logLevel: 'info',
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
});

if (watch) {
  await context.watch();
  console.log('Watching MarkLab Obsidian plugin files...');
} else {
  await context.rebuild();
  await context.dispose();
}
