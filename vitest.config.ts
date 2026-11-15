import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['apps/api/src/**/*.ts', 'packages/contracts/src/**/*.ts'],
      exclude: ['**/*.d.ts'],
      thresholds: {
        ...(process.env.OMNIHUB_COVERAGE_SCOPE === 'ci'
          ? { lines: 55, statements: 45, branches: 48, functions: 45 }
          : {}),
        'apps/api/src/auth.ts': { lines: 95, statements: 95, functions: 95, branches: 90 },
        'apps/api/src/card-provider.ts': { lines: 95, statements: 95, functions: 95, branches: 95 },
        'apps/api/src/catalog-domain.ts': { lines: 90, statements: 90, functions: 85, branches: 90 },
        'apps/api/src/commands.ts': { lines: 65, statements: 65, functions: 80, branches: 50 },
        'apps/api/src/deployment-security.ts': { lines: 95, statements: 90, functions: 95, branches: 85 },
        'apps/api/src/domain.ts': { lines: 95, statements: 95, functions: 95, branches: 90 },
        'apps/api/src/rate-limit.ts': { lines: 95, statements: 95, functions: 95, branches: 85 },
        'packages/contracts/src/admin.ts': { lines: 95, statements: 80, functions: 50, branches: 95 },
        'packages/contracts/src/index.ts': { lines: 95, statements: 95, functions: 95, branches: 95 },
      },
    },
  },
});
