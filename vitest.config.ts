import { defineConfig } from 'vitest/config';

const integrationEnabled = process.env.LYNTARI_INTEGRATION_TEST === '1';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    exclude: integrationEnabled
      ? []
      : ['tests/integration.test.ts', 'tests/integration/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/build/**', 'src/**/index.ts'],
    },
  },
});
