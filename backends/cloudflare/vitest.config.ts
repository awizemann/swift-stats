import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// String paths throughout: `@cloudflare/workers-types` and `@types/node` each
// declare a `URL`, and the two are not assignable to one another, so passing a
// `URL` to `node:fs` here does not typecheck even though it works at runtime.
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * The real migration files, read here (Node side) and handed to the test Worker
 * as a plain binding.
 *
 * Test code runs inside workerd and has no filesystem, so the migrations have to
 * cross the boundary as data. They are read from `./migrations` — the same
 * directory `wrangler d1 migrations apply` uses — so the suite exercises the
 * schema that actually ships. A hand-written test schema is how a backend's
 * suite passes while its migration is wrong.
 */
const MIGRATIONS_SQL = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), 'utf8'));

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Read the real wrangler.toml so the tests exercise the same bindings the
      // deployment uses.
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        // Local D1, in memory, fresh per run. `wrangler d1 create` is never
        // needed for tests, so `database_id` in wrangler.toml stays a
        // placeholder in the repo.
        d1Databases: { DB: 'stats-test' },
        bindings: { MIGRATIONS_SQL },
      },
      // Storage is deliberately shared across tests: every test calls
      // `resetDatabase()`, which drops the tables and re-applies the migrations
      // above. State is explicit rather than dependent on the pool's rollback
      // semantics, and the migration is re-exercised on every single test.
    }),
  ],
});
