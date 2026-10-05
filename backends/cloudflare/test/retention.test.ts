// `set-retention` has two writers that cannot share code: `setProjectRetention`
// (src/retention.ts, TypeScript, used by the Worker's lib consumers) and
// `scripts/admin.mjs` (dependency-free Node, which cannot import it). Both must
// run the SAME statement, or the CLI could raise a window without moving
// `raw_complete_from` (0007) the way the Worker's own writer does. This pins it.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS } from '../src/dates.js';
import { SET_RETENTION_SQL } from '../src/retention.js';

const { ADMIN_MJS } = env as unknown as { ADMIN_MJS: string };

describe('admin.mjs set-retention ↔ SET_RETENTION_SQL', () => {
  it('the CLI carries the Worker statement verbatim', () => {
    const match = /const SET_RETENTION_SQL = `([\s\S]*?)`;/.exec(ADMIN_MJS);
    expect(match, 'SET_RETENTION_SQL template literal not found in admin.mjs').not.toBeNull();
    const evaluated = (match?.[1] ?? '')
      .replaceAll('${MIN_RETENTION_DAYS}', String(MIN_RETENTION_DAYS))
      .replaceAll('${MAX_RETENTION_DAYS}', String(MAX_RETENTION_DAYS));
    expect(evaluated).not.toContain('${');
    expect(evaluated).toBe(SET_RETENTION_SQL);
  });

  it('the CLI uses it for set-retention, not a bare UPDATE of the column', () => {
    const command = ADMIN_MJS.slice(ADMIN_MJS.indexOf("case 'set-retention'"));
    const body = command.slice(0, command.indexOf('break;'));
    expect(body).toContain('SET_RETENTION_SQL');
    expect(body).not.toMatch(/UPDATE projects SET retention_days/);
  });
});
