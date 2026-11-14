import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests read DB credentials from the project's .env file.
    env: loadRootEnv(),
  },
});

function loadRootEnv(): Record<string, string> {
  try {
    process.loadEnvFile(new URL('../.env', import.meta.url));
  } catch {
    // No .env: DB integration tests will skip themselves.
  }
  return { ...process.env } as Record<string, string>;
}
