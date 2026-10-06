#!/usr/bin/env node
// stats-worker admin CLI — create projects, mint and revoke keys, erase an
// install or one user. Node 20+, no dependencies.
//
// It generates SQL and (unless you pass --dry-run) hands it to
// `wrangler d1 execute`. Nothing here talks to D1 directly, so there is no
// second set of credentials to manage: whatever `wrangler` is already logged
// into is what gets touched, and `--local` vs `--remote` is explicit on every
// invocation.
//
// The one rule: a minted key's PLAINTEXT is printed to stdout exactly once and
// never written anywhere. Only its SHA-256 goes into D1. If you lose it, revoke
// it and mint another — there is deliberately no recovery path, because a
// recoverable key is a key that a database dump hands to an attacker.
//
//   node scripts/admin.mjs create-project overwatch "Overwatch" --local
//   node scripts/admin.mjs mint-key overwatch write --label "macOS 1.4" --local
//   node scripts/admin.mjs mint-key overwatch read  --label "Overwatch app" --local
//   node scripts/admin.mjs mint-key overwatch admin --label "account server" --local
//   node scripts/admin.mjs list-keys overwatch --local
//   node scripts/admin.mjs set-retention overwatch 180 --local
//   node scripts/admin.mjs revoke-key <key-hash> --local
//   node scripts/admin.mjs delete-install <installId> --local
//   node scripts/admin.mjs delete-user overwatch <userIdHash> --unlink|--delete --local
//
// Add --remote instead of --local to act on the deployed database. --dry-run
// prints the SQL and exits, which is the safe way to review a destructive one.

import { spawnSync } from 'node:child_process';
import { webcrypto as crypto } from 'node:crypto';

const DB_NAME = 'stats';
const PROJECT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const INSTALL_ID_RE = /^[0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
// Mirrors USER_ID_HASH_RE in src/lib/erase.ts: the SDK's `userId` is
// lowercaseHex(SHA256(userID + installIdSalt)), never the raw account id.
const USER_ID_HASH_RE = /^[0-9a-f]{64}$/;
// Mirrors ERASE_CHUNK_ROWS in src/lib/erase.ts — rows per statement, so each one
// finishes far inside D1's per-statement time limit.
const ERASE_CHUNK_ROWS = 5000;

// `delete-user`'s statements — VERBATIM the template literals of the same names
// in src/lib/erase.ts (this script cannot import TypeScript). The test suite
// compares the texts (test/erase.test.ts), so an edit to one alone fails it.
// Placeholders: ?1 project id, ?2 user hash, ?3 chunk size, ?4 now; `{table}`
// a rollup table.
const ERASE_ROLLUP_TABLES = ['daily_rollups', 'daily_event_rollups', 'daily_prop_rollups'];
const ERASE_TOMBSTONE_SQL = `INSERT INTO erased_users (project_id, user_id, mode, erased_at)
VALUES (?1, ?2, ?3, ?4)
ON CONFLICT (project_id, user_id) DO UPDATE
  SET mode = CASE WHEN erased_users.mode = 'delete' THEN 'delete' ELSE excluded.mode END,
      erased_at = excluded.erased_at`;
const CHUNK_IDS = `SELECT id FROM events WHERE project_id = ?1 AND user_id = ?2 ORDER BY id LIMIT ?3`;
const ERASE_UNLINK_SQL = `UPDATE events SET user_id = NULL WHERE id IN (${CHUNK_IDS})`;
const ERASE_DELETE_SQL = `DELETE FROM events WHERE id IN (${CHUNK_IDS})`;
const ERASE_CLEAR_ROLLUPS_SQL = `DELETE FROM {table}
 WHERE project_id = ?1
   AND day IN (SELECT day FROM events WHERE id IN (${CHUNK_IDS}))
   AND day >= COALESCE((SELECT raw_complete_from FROM projects WHERE id = ?1), '')
   AND NOT EXISTS (SELECT 1 FROM events e
                    WHERE e.project_id = ?1 AND e.day = {table}.day
                      AND e.id NOT IN (${CHUNK_IDS}))`;

/** Substitute `?N` placeholders with already-quoted SQL values, highest N first. */
function bindSql(sql, values) {
  let out = sql;
  for (let i = values.length; i >= 1; i -= 1) out = out.replaceAll(`?${i}`, values[i - 1]);
  return out.replace(/\s+/g, ' ');
}
// Per kind; mirrors KEY_PREFIXES in src/keys.ts (the cross-repo key format).
const KEY_PREFIXES = { write: 'sk_stats', read: 'rk_stats', admin: 'ak_stats' };
// Mirrors MIN_RETENTION_DAYS / MAX_RETENTION_DAYS in src/dates.ts. Duplicated
// rather than imported: this script is dependency-free Node and deliberately
// does not load the Worker's TypeScript.
const MIN_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 400;

// `set-retention`'s statement — VERBATIM the template literal SET_RETENTION_SQL
// in src/retention.ts (this script cannot import TypeScript). The test suite
// compares the two texts (test/retention.test.ts), so an edit to one alone fails
// it. Binds ?1 project id, ?2 window in days, ?3 today; substituted below.
const SET_RETENTION_SQL = `UPDATE projects
   SET raw_complete_from = CASE
         WHEN ?2 > max(${MIN_RETENTION_DAYS}, min(${MAX_RETENTION_DAYS}, COALESCE(retention_days, ${MIN_RETENTION_DAYS})))
         THEN max(
                COALESCE(raw_complete_from, ''),
                min(
                  date(?3, '-' || (max(${MIN_RETENTION_DAYS}, min(${MAX_RETENTION_DAYS}, COALESCE(retention_days, ${MIN_RETENTION_DAYS}))) - 1) || ' days'),
                  COALESCE((SELECT MIN(day) FROM events WHERE project_id = projects.id), '9999-12-31')
                )
              )
         ELSE raw_complete_from
       END,
       retention_days = ?2
 WHERE id = ?1`;

// Human-readable free text: a project's display name and a key's label.
//
// `q()` escapes the quote, so this is not the injection guard — it is the second
// of the two the file's header describes, and it is the one that stops a value
// that is merely absurd. Printable ASCII plus spaces, bounded: `wrangler d1
// execute --command` puts the whole statement on a command line, so an unbounded
// value is an ARG_MAX failure with a confusing message, and a newline or a
// control character in a stored label is a log-injection hazard the moment
// `list-keys` prints it back. No `'` and no `;`, so a value that would need
// escaping is refused outright rather than escaped and stored.
const FREE_TEXT_RE = /^[A-Za-z0-9 ._,()/+&#@:-]{1,120}$/;
const FREE_TEXT_HELP = "1-120 chars of letters, digits, spaces and . _ , ( ) / + & # @ : -";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
// The label is consumed BY INDEX, not by value. Filtering positionals by
// `a !== label` would drop a project id that happened to equal the label —
// `mint-key overwatch write --label overwatch` would silently lose the id and
// mis-parse the whole command.
const labelIndex = argv.indexOf('--label');
const label = labelIndex === -1 ? null : (argv[labelIndex + 1] ?? null);
const positionals = argv.filter(
  (a, i) => !a.startsWith('--') && !(labelIndex !== -1 && i === labelIndex + 1),
);

const dryRun = flags.has('--dry-run');
const remote = flags.has('--remote');
const local = flags.has('--local');
// Optional: WRANGLER_CONFIG=wrangler.prod.toml — forwarded as `--config` so an
// operator who keeps the real D1 id in a git-ignored file (as the reference
// deployment does) can act on it without editing the shipped wrangler.toml.
const configArgs = process.env.WRANGLER_CONFIG ? ['--config', process.env.WRANGLER_CONFIG] : [];

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

/**
 * Single-quote a value for SQL.
 *
 * Every value that reaches this function is also pattern-checked by its caller,
 * so this is the second of two independent guards rather than the only one —
 * `wrangler d1 execute` has no parameter binding, so string building is
 * unavoidable here and one guard is not enough.
 */
function q(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** ISO 8601 UTC with millisecond precision and a literal Z, per schema §0. */
function nowIso() {
  return new Date().toISOString();
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function mint(kind) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const b64 = Buffer.from(bytes).toString('base64url');
  const key = `${KEY_PREFIXES[kind]}_${b64}`;
  return { key, hash: await sha256Hex(key) };
}

function execute(sql) {
  console.log('\n--- SQL ---');
  console.log(sql);
  if (dryRun) {
    console.log('\n(--dry-run: nothing executed)');
    return;
  }
  if (!local && !remote) {
    die('pass --local or --remote (or --dry-run to just print the SQL)');
  }
  const args = ['d1', 'execute', DB_NAME, local ? '--local' : '--remote', ...configArgs, '--command', sql];
  if (!local) args.push('--yes');
  const result = spawnSync('wrangler', args, { stdio: 'inherit' });
  if (result.status !== 0) die(`wrangler exited with ${result.status ?? 'a signal'}`);
}

/** Run a SELECT and return its rows, or `null` if the query could not be run. */
function query(sql) {
  if (!local && !remote) return null;
  const args = [
    'd1', 'execute', DB_NAME, local ? '--local' : '--remote', ...configArgs, '--json', '--command', sql,
  ];
  if (!local) args.push('--yes');
  const result = spawnSync('wrangler', args, { encoding: 'utf8' });
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    // wrangler returns an array of per-statement results.
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    return first?.results ?? null;
  } catch {
    return null;
  }
}

/**
 * Run one data-changing statement quietly (no output unless it fails).
 *
 * For `delete-user`'s loop, which would otherwise print wrangler's banner once
 * per chunk. It does not report a changed-row count, on purpose: `wrangler d1
 * execute --local --json` omits `meta.changes` (only `--remote` reports it), so
 * the loop decides "done" by asking the table instead — which is also the
 * question that matters ("is anything still linked?"), not a proxy for it.
 */
function executeQuiet(sql) {
  const args = ['d1', 'execute', DB_NAME, local ? '--local' : '--remote', ...configArgs, '--command', sql];
  if (!local) args.push('--yes');
  const result = spawnSync('wrangler', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '');
    die(`wrangler exited with ${result.status ?? 'a signal'} (re-run the same command to resume)`);
  }
}

/**
 * Refuse to mint a key for a project that does not exist.
 *
 * Without this, `mint-key overwtach write` (one transposition) printed a
 * perfectly convincing key, banner and all, and inserted a `keys` row pointing at
 * nothing. The key then 401s on every request, and the 401 is deliberately
 * indistinguishable from a revoked or wrong-scope key (§8), so the mistake
 * surfaces as "the SDK does not work" days later, in someone else's app.
 *
 * `null` from `query` means we could not check — `--dry-run`, or wrangler failing
 * for its own reasons — and a check that could not run must not block the
 * operator. The `keys.project_id` foreign key is the backstop in that case.
 */
function requireProjectExists(projectId) {
  if (dryRun) return;
  const rows = query(`SELECT id FROM projects WHERE id = ${q(projectId)};`);
  if (rows === null) {
    console.warn('warning: could not verify the project exists; continuing');
    return;
  }
  if (rows.length === 0) {
    die(
      `no project "${projectId}" exists. Create it first:\n` +
        `  node scripts/admin.mjs create-project ${projectId} "<name>" ${local ? '--local' : '--remote'}`,
    );
  }
}

if (label !== null && !FREE_TEXT_RE.test(label)) {
  die(`--label must be ${FREE_TEXT_HELP}`);
}

const [command, ...rest] = positionals;

switch (command) {
  case 'create-project': {
    const [id, name] = rest;
    if (!id || !PROJECT_ID_RE.test(id)) die('project id must match [A-Za-z0-9._-]{1,64}');
    if (!name) die('usage: create-project <id> <name>');
    if (!FREE_TEXT_RE.test(name)) die(`project name must be ${FREE_TEXT_HELP}`);
    execute(
      `INSERT INTO projects (id, name, created_at) VALUES (${q(id)}, ${q(name)}, ${q(nowIso())});`,
    );
    break;
  }

  case 'mint-key': {
    const [projectId, kind] = rest;
    if (!projectId || !PROJECT_ID_RE.test(projectId)) die('project id must match [A-Za-z0-9._-]{1,64}');
    if (!Object.hasOwn(KEY_PREFIXES, kind ?? '')) die("kind must be 'write', 'read' or 'admin'");
    // BEFORE minting: a key printed for a nonexistent project looks entirely
    // valid and 401s forever, and §8 makes that 401 indistinguishable from a
    // revoked key.
    requireProjectExists(projectId);

    const { key, hash } = await mint(kind);
    execute(
      `INSERT INTO keys (key_hash, project_id, kind, label, created_at) VALUES (` +
        `${q(hash)}, ${q(projectId)}, ${q(kind)}, ${q(label)}, ${q(nowIso())});`,
    );

    console.log('\n=========================================================');
    console.log(`  ${kind.toUpperCase()} KEY for project "${projectId}"`);
    console.log('');
    console.log(`  ${key}`);
    console.log('');
    console.log('  Printed ONCE. Only its SHA-256 is stored.');
    if (kind === 'write') {
      console.log('  Ships inside the app binary; grants append-only access to');
      console.log('  this one project (schema §2.4). Safe to embed, by design.');
    } else if (kind === 'admin') {
      console.log('  Grants ONLY POST /v1/users/erase for this project (schema §8.4):');
      console.log('  it cannot ingest or read. MUST NOT ship in an app: keep it on');
      console.log("  the server that handles account deletion, in its secret store.");
    } else {
      console.log('  MUST NOT be embedded in a shipped client app (schema §8).');
      console.log('  Keychain / a server-side secret store only.');
    }
    console.log('=========================================================');
    break;
  }

  case 'revoke-key': {
    const [hash] = rest;
    if (!hash || !HASH_RE.test(hash)) die('pass the 64-hex key_hash (see list-keys)');
    // UPDATE, not DELETE: `keys` stays an audit trail of everything ever minted
    // for a project. The Worker filters on `revoked_at IS NULL`.
    execute(`UPDATE keys SET revoked_at = ${q(nowIso())} WHERE key_hash = ${q(hash)};`);
    break;
  }

  case 'list-keys': {
    const [projectId] = rest;
    if (!projectId || !PROJECT_ID_RE.test(projectId)) die('project id must match [A-Za-z0-9._-]{1,64}');
    // `last_used_at` (migration 0004) is the column rotation actually needs: it
    // answers "is the key I am about to revoke still carrying traffic?", which
    // neither `created_at` nor `revoked_at` can. NULL means never seen since that
    // migration ran, and the Worker coalesces the write to at most once a minute,
    // so a value up to 60 seconds stale is expected and does not mean idle.
    execute(
      `SELECT key_hash, kind, label, created_at, last_used_at, revoked_at FROM keys ` +
        `WHERE project_id = ${q(projectId)} ORDER BY created_at;`,
    );
    break;
  }

  case 'set-retention': {
    const [projectId, days] = rest;
    if (!projectId || !PROJECT_ID_RE.test(projectId)) die('project id must match [A-Za-z0-9._-]{1,64}');
    // Bounds refused here rather than clamped silently: an operator typing 30 is
    // asking for something this backend will not do (the read layer would still
    // serve those days), and quietly storing 90 instead would look like it worked.
    // The Worker clamps on read as a backstop against a hand-edited row.
    if (!/^\d+$/.test(days ?? '')) die('usage: set-retention <projectId> <days>');
    const n = Number(days);
    if (n < MIN_RETENTION_DAYS || n > MAX_RETENTION_DAYS) {
      die(`retention must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days`);
    }
    requireProjectExists(projectId);
    // NOT a bare `SET retention_days`: on an increase this also moves
    // `raw_complete_from` (0007) in the same statement, so the days the old window
    // already swept are never treated as raw-complete again.
    execute(
      SET_RETENTION_SQL.replaceAll('?1', q(projectId))
        .replaceAll('?2', String(n))
        .replaceAll('?3', "date('now')")
        .replace(/\s+/g, ' ') + ';',
    );
    console.log('\nRaw events beyond this window are deleted by the nightly job.');
    console.log('Rollups are unaffected — they are kept indefinitely either way.');
    break;
  }

  case 'delete-install': {
    const [installId] = rest;
    if (!installId || !INSTALL_ID_RE.test(installId)) die('installId must be 64 lowercase hex chars');
    // The §13 erasure obligation. Raw rows go immediately; already-computed
    // rollups still include this install's contribution until the affected days
    // are re-rolled, which the nightly job does for the last few days only. For
    // an older day, re-run the rollup for that day explicitly (see the README).
    // BOTH tables. `installs` (migration 0005) is exempt from the raw retention
    // sweep by design, so an erasure that only cleared `events` would leave this
    // install's id and first-seen day behind indefinitely — which is exactly the
    // §13 obligation this command exists to discharge.
    execute(
      `DELETE FROM events WHERE install_id = ${q(installId)}; ` +
        `DELETE FROM installs WHERE install_id = ${q(installId)};`,
    );
    console.log('\nNote: rollups for days outside the nightly re-roll window still');
    console.log('include this install. See README "Deleting one install".');
    break;
  }

  case 'delete-user': {
    const [projectId, userIdHash] = rest;
    if (!projectId || !PROJECT_ID_RE.test(projectId)) die('project id must match [A-Za-z0-9._-]{1,64}');
    if (!userIdHash || !USER_ID_HASH_RE.test(userIdHash)) {
      die(
        'userIdHash must be 64 lowercase hex: the SHA-256 of userID + installIdSalt the SDK sends,\n' +
          '  never the account id itself (README "Erasing one user")',
      );
    }
    // The mode is REQUIRED, as on the endpoint: the two differ in whether data
    // survives, so neither is a default. And a misspelled flag (`--unlnk`) must
    // not fall through to whichever mode happens to be the fallback.
    const allowed = new Set(['--unlink', '--delete', '--local', '--remote', '--dry-run']);
    for (const f of flags) if (!allowed.has(f)) die(`unknown flag for delete-user: ${f}`);
    if (flags.has('--unlink') === flags.has('--delete')) die('pass exactly one of --unlink or --delete');
    const mode = flags.has('--unlink') ? 'unlink' : 'delete';

    // The same statements as POST /v1/users/erase (src/lib/erase.ts), as SQL
    // for `wrangler d1 execute`, which has no loop and no binding — so the loop
    // is here and each chunk is its own command. Scoped to ONE project: the same
    // hash in another project is a different person's link and is untouched.
    // `installs` is deliberately NOT touched (see src/lib/erase.ts); to erase a
    // whole install too, use delete-install.
    const P = q(projectId);
    const H = q(userIdHash);
    const N = String(ERASE_CHUNK_ROWS);
    const tombstoneSql =
      bindSql(ERASE_TOMBSTONE_SQL, [P, H, q(mode), "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"]) + ';';
    // A delete chunk is the rollup clears THEN the delete, in one command, the
    // order the endpoint's batch uses: the clears compute the days the chunk
    // empties from the chunk's own rows, in SQL, so nothing is read between
    // statements. Whether wrangler runs a multi-statement `--command` as one
    // transaction is wrangler's business; if it does not and a run dies
    // between the clears and the delete, the clears were for rows that are
    // still there: a day inside the raw-read window reads from those rows
    // meanwhile (one below the clock cutoff reads empty until the nightly
    // sweep re-rolls it), the rerun recomputes the same days and finishes, and
    // a day never finished is re-rolled from its raw rows by the nightly job.
    const chunkSql =
      mode === 'unlink'
        ? bindSql(ERASE_UNLINK_SQL, [P, H, N]) + ';'
        : [
            ...ERASE_ROLLUP_TABLES.map(
              (table) => bindSql(ERASE_CLEAR_ROLLUPS_SQL.replaceAll('{table}', table), [P, H, N]) + ';',
            ),
            bindSql(ERASE_DELETE_SQL, [P, H, N]) + ';',
          ].join('\n');
    const countSql =
      `SELECT COUNT(*) AS n FROM events WHERE project_id = ${P} AND user_id = ${H};`;

    console.log('\n--- SQL (the tombstone, then one chunk, repeated until the count reaches 0) ---');
    console.log(tombstoneSql);
    console.log(chunkSql);
    console.log(countSql);
    if (dryRun) {
      console.log('\n(--dry-run: nothing executed)');
      break;
    }
    if (!local && !remote) die('pass --local or --remote (or --dry-run to just print the SQL)');
    requireProjectExists(projectId);

    // The tombstone FIRST, as the endpoint does, so ingest stops adding rows
    // for this hash before the chunks start (README "Erasing one user").
    executeQuiet(tombstoneSql);

    // Count, erase a chunk, count again, until nothing is left. Each pass is
    // idempotent ("whatever is still linked"), so an interrupted run is resumed
    // by running the same command again. The count rides the `events_user`
    // partial index (0009): it reads this user's rows, not the project's.
    const remaining = () => {
      const rows = query(countSql);
      const n = rows?.[0]?.n;
      if (typeof n !== 'number') die('could not count the remaining events; stopping (re-run to resume)');
      return n;
    };
    const total = remaining();
    console.log(`\n${total} event(s) linked to this userId in project "${projectId}".`);
    let left = total;
    while (left > 0) {
      executeQuiet(chunkSql);
      const after = remaining();
      // A chunk that erased nothing while rows remain would loop forever.
      if (after >= left) die(`no progress (${after} still linked); stopping`);
      left = after;
      console.log(`  ${mode === 'unlink' ? 'unlinked' : 'deleted'} ${total - left} of ${total}`);
    }
    console.log(`\nDone: ${total} event(s) ${mode === 'unlink' ? 'unlinked' : 'deleted'} in project "${projectId}".`);
    if (mode === 'unlink') {
      console.log('Rollups are unchanged and stay exact: none of them ever held a userId.');
      console.log('Unlinking is final for these rows: a later --delete for this userId');
      console.log('cannot find them (nothing ties them to it any more).');
    } else {
      console.log('Rollups of days left with no events were cleared (never below the');
      console.log("project's raw_complete_from); days with other events are recomputed by");
      console.log('the next nightly re-roll or at age-out. See README "Erasing one user".');
    }
    console.log('A tombstone keeps ingest from re-linking this userId for the project\'s');
    console.log('retention window plus 30 days.');
    break;
  }

  default:
    console.log(`stats-worker admin

  create-project <id> <name>
  mint-key <projectId> write|read|admin [--label "text"]
  set-retention <projectId> <days>          # raw-event window, 90-400
  list-keys <projectId>
  revoke-key <key-hash>
  delete-install <installId>
  delete-user <projectId> <userIdHash> --unlink|--delete   # --unlink keeps the events

Flags: --local | --remote | --dry-run`);
    process.exit(command === undefined ? 0 : 1);
}
