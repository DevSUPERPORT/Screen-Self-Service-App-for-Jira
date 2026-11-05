/**
 * Vitest config: runs the .test.ts files under tests with tests/setup.ts (in-memory KVS) as setup file, in
 * forked processes with long timeouts for the large-instance and property tests.
 *
 * @file        vitest.config.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
    pool: 'forks',
  },
});
