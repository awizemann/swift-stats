#!/usr/bin/env node
// stats-worker admin CLI — create projects, mint and revoke keys, erase an
// install. Node 20+, no dependencies.
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
//   node scripts/admin.mjs list-keys overwatch --local
//   node scripts/admin.mjs revoke-key <key-hash> --local
//   node scripts/admin.mjs delete-install <installId> --local
//
// Add --remote instead of --local to act on the deployed database. --dry-run
// prints the SQL and exits, which is the safe way to review a destructive one.

import { spawnSync } from 'node:child_process';
import { webcrypto as crypto } from 'node:crypto';

const DB_NAME = 'stats';
const PROJECT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const INSTALL_ID_RE = /^[0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

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
  const key = `${kind === 'write' ? 'sk_stats' : 'rk_stats'}_${b64}`;
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
    if (kind !== 'write' && kind !== 'read') die("kind must be 'write' or 'read'");
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
    execute(
      `SELECT key_hash, kind, label, created_at, revoked_at FROM keys ` +
        `WHERE project_id = ${q(projectId)} ORDER BY created_at;`,
    );
    break;
  }

  case 'delete-install': {
    const [installId] = rest;
    if (!installId || !INSTALL_ID_RE.test(installId)) die('installId must be 64 lowercase hex chars');
    // The §13 erasure obligation. Raw rows go immediately; already-computed
    // rollups still include this install's contribution until the affected days
    // are re-rolled, which the nightly job does for the last few days only. For
    // an older day, re-run the rollup for that day explicitly (see the README).
    execute(`DELETE FROM events WHERE install_id = ${q(installId)};`);
    console.log('\nNote: rollups for days outside the nightly re-roll window still');
    console.log('include this install. See README "Deleting one install".');
    break;
  }

  default:
    console.log(`stats-worker admin

  create-project <id> <name>
  mint-key <projectId> write|read [--label "text"]
  list-keys <projectId>
  revoke-key <key-hash>
  delete-install <installId>

Flags: --local | --remote | --dry-run`);
    process.exit(command === undefined ? 0 : 1);
}
