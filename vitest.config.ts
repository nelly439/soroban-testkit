import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli/main.ts'],
      reporter: ['text-summary', 'text', 'json-summary', 'lcov'],
      thresholds: { lines: 85 },
    },
  },
});
