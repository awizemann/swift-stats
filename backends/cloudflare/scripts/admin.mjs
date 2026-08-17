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
  const args = ['d1', 'execute', DB_NAME, local ? '--local' : '--remote', '--command', sql];
  if (!local) args.push('--yes');
  const result = spawnSync('wrangler', args, { stdio: 'inherit' });
  if (result.status !== 0) die(`wrangler exited with ${result.status ?? 'a signal'}`);
}

const [command, ...rest] = positionals;

switch (command) {
  case 'create-project': {
    const [id, name] = rest;
    if (!id || !PROJECT_ID_RE.test(id)) die('project id must match [A-Za-z0-9._-]{1,64}');
    if (!name) die('usage: create-project <id> <name>');
    execute(
      `INSERT INTO projects (id, name, created_at) VALUES (${q(id)}, ${q(name)}, ${q(nowIso())});`,
    );
    break;
  }

  case 'mint-key': {
    const [projectId, kind] = rest;
    if (!projectId || !PROJECT_ID_RE.test(projectId)) die('project id must match [A-Za-z0-9._-]{1,64}');
    if (kind !== 'write' && kind !== 'read') die("kind must be 'write' or 'read'");

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
