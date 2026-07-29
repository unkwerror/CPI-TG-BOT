import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
  resolve: {
    alias: {
      '@cpi/shared': new URL('./packages/shared/src/index.ts', import.meta.url).pathname,
      '@cpi/config': new URL('./packages/config/src/index.ts', import.meta.url).pathname,
      '@cpi/db': new URL('./packages/db/src/index.ts', import.meta.url).pathname,
    },
  },
});
