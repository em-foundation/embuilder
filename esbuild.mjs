import { build } from 'esbuild'

await build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: 'out/extension.js',
    external: ['vscode', 'node-screenshots', 'node-screenshots-*'],
})
