import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  external: ['pg'],
  noExternal: ['@cpi/config', '@cpi/db', '@cpi/shared'],
});
