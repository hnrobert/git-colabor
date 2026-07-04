import { defineConfig } from 'tsup';

export default defineConfig({
  // askpass entry is added in M2 (identity/SSH).
  entry: { cli: 'src/cli/index.ts', index: 'src/index.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node18',
  outDir: 'dist',
  splitting: false,
  sourcemap: false,
  treeshake: true,
  clean: true,
  // bundle everything into a single file (zero runtime deps)
  noExternal: [/.*/],
});
