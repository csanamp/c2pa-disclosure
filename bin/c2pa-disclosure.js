#!/usr/bin/env node
'use strict';

// CLI entry point. Every input is a command-line argument — nothing is read
// from the environment — so the tool can be driven by a processing-jobs
// definition without ambient configuration.

const fs = require('fs');
const path = require('path');

const { AmplienceClient } = require('../lib/amplience');
const { run } = require('../lib/run');
const { getReader } = require('../lib/reader');

const TRUST_DIR = path.join(__dirname, '..', 'lib', 'trust');
const DEFAULT_ANCHORS = path.join(TRUST_DIR, 'anchors-2026-08-20.pem');
const DEFAULT_ALLOWED = path.join(TRUST_DIR, 'allowed-2026-08-20.sha256.txt');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const HELP = `c2pa-disclosure — classify DAM assets by AI provenance and record the verdict

  Reads C2PA Content Credentials from each asset's ORIGINAL bytes, classifies it
  as fullyGenerated / partiallyModified / none / unknown, and writes that value
  to a metadata field. Safe to run on a schedule: assets that already carry a
  value are skipped.

AUTH (first available wins)
  --token TOKEN            bearer token for a user in the target company
  AMP_SESSION_TOKEN        env var set by the Amplience job runner; base64
  --auth-host URL          with --client-id/--username/--password, mint one

TARGET
  --dam-host URL           DAM API base incl. version path
                           (default https://dam-api.amplience.net/v1.5.0)
  --bucket UUID            restrict to one bucket
  --query 'Q'              Lucene-style asset query, passed through as ?q=
  --query-b64 B64          same, base64-encoded — use this under Amplience
                           processing jobs, whose argument parser splits on
                           spaces and cannot represent a quoted value
  --limit N                stop after N candidates (default: no limit)
  --sort FIELD:DIR         result order, e.g. updated:asc. Comma-separated for
                           multiple keys. The default is updated:desc, which
                           puts assets this job just published ahead of the
                           backlog — with --limit, use updated:asc so the limit
                           is spent on work that has not been done yet.
  --since DURATION         only assets newer than e.g. 90m, 24h, 7d
                           (client-side; relies on the default order, so it
                           cannot be combined with --sort)

SCHEMA  (all three required unless --dry-run)
  --schema-name UUID       schema NAME  — used to attach the schema to an asset
  --schema-id UUID         schema ID    — used to write values
  --field NAME             property within the schema (default aiDisclosure)
  --version-field NAME     numeric property holding the asset revision that was
                           analysed. Strongly recommended: without it an asset
                           whose bytes are replaced after classification is
                           never re-examined, so a clean asset labelled 'none'
                           can be swapped for AI content and stay unlabelled.

BEHAVIOUR
  --dry-run                classify and report, write nothing
  --force                  overwrite assets that already have a value
  --publish                publish assets whose verdict changed (the default)
  --no-publish             write metadata but skip publishing
  --concurrency N          parallel downloads (default 4)
  --reason TEXT            recorded against each download in the audit trail
  --trust-anchors FILE     PEM of trusted roots (default: bundled list)
  --allowed-list FILE      allowed end-entity hashes (default: bundled list)
  --no-trust               skip trust verification entirely
  --require-verification   refuse to run if signatures cannot be verified
                           (i.e. if the pure-JS fallback reader is in use)
  --json FILE              write per-asset results as JSONL
  --quiet                  suppress progress output

EXAMPLES
  # hourly job: anything new that has not been classified yet
  c2pa-disclosure --token "$TOKEN" --bucket "$BUCKET" \\
    --schema-name "$SNAME" --schema-id "$SID" --field aiDisclosure \\
    --query "-aiDisclosure.aiDisclosure:* AND -name:eu-ai-icon* AND created:[NOW -1HOUR TO *]"

  # see what it would do, without writing
  c2pa-disclosure --token "$TOKEN" --bucket "$BUCKET" --limit 20 --dry-run
`;

if (has('--help') || argv.length === 0) { console.log(HELP); process.exit(0); }

// Unrecognised flags are otherwise ignored in silence, which is a poor fit for
// a runner that splits `args` on spaces: a mangled value reappears as a flag
// nobody asked for, and the job reports success having done the wrong thing.
// `--publish` is accepted because publishing is the default and writing it out
// is a reasonable thing to expect to work.
const KNOWN = new Set([
  '--allowed-list', '--auth-host', '--bucket', '--client-id', '--concurrency',
  '--dam-host', '--dry-run', '--field', '--force', '--help', '--json', '--limit',
  '--no-publish', '--no-trust', '--password', '--publish', '--query', '--query-b64',
  '--quiet', '--reason', '--require-verification', '--schema-id', '--schema-name',
  '--since', '--sort', '--token', '--trust-anchors', '--username', '--version-field',
]);
const unknown = argv.filter((a) => a.startsWith('--') && !KNOWN.has(a));
if (unknown.length) {
  process.stderr.write(`error: unrecognised argument(s): ${unknown.join(' ')}\n`);
  process.stderr.write('       run with --help for the full list\n');
  process.exit(2);
}

// The Amplience job runner splits the `args` job parameter on spaces with no
// quote handling, so any argument value containing a space is torn into
// separate argv entries. A useful asset query almost always contains one
// (`... AND ...`), hence --query-b64: base64 has no spaces and survives the
// split intact.
function resolveQuery() {
  const plain = val('--query');
  const b64 = val('--query-b64');
  if (plain && b64) fail('pass --query or --query-b64, not both');
  if (!b64) return plain;
  let decoded;
  try {
    decoded = Buffer.from(b64, 'base64').toString('utf8').trim();
  } catch (e) {
    fail(`--query-b64 is not valid base64: ${e.message}`);
  }
  if (!decoded) fail('--query-b64 decoded to an empty string');
  // Round-trip check: base64 decoding is lenient and will happily turn a
  // plain-text query into mojibake rather than failing.
  if (Buffer.from(decoded, 'utf8').toString('base64').replace(/=+$/, '') !== b64.replace(/=+$/, '')) {
    fail(`--query-b64 did not round-trip; it decoded to "${decoded.slice(0, 60)}". ` +
         'Encode with:  printf %s \'<query>\' | base64');
  }
  return decoded;
}

// The API takes `field:asc|desc`, splitting on the colon — Solr's own
// `field desc` form arrives without one, so the whole string becomes the field
// name and the request 500s. Two other shapes 500 the same way, both worth
// catching here because the server-side error says only "Unable to search
// assets" and gives no clue which argument was at fault.
const UNSORTABLE = new Set(['srcName', 'file']);
const DOTTED_SORTABLE = /^(lastPublish|lastSuccess|lastUnpublish|lastUnpublishSuccess|workflow)\./;

function validateSort(s) {
  if (!s) return null;
  for (const clause of s.split(',')) {
    const [field, dir = 'asc', ...rest] = clause.trim().split(':');
    if (!field || rest.length) fail(`--sort clause "${clause.trim()}" is not FIELD or FIELD:asc|desc`);
    if (/\s/.test(field)) {
      fail(`--sort takes "${field.split(/\s+/)[0]}:desc", not Solr's "${clause.trim()}"`);
    }
    if (!['asc', 'desc'].includes(dir.toLowerCase())) {
      fail(`--sort direction must be asc or desc (got "${dir}")`);
    }
    if (UNSORTABLE.has(field)) fail(`--sort on "${field}" is refused by the DAM API`);
    // Sort keys skip the schema-name remapping that queries get, so a metadata
    // field reaches Solr as an undefined field.
    if (field.includes('.') && !DOTTED_SORTABLE.test(field)) {
      fail(`--sort cannot use the metadata field "${field}" — only asset fields are sortable`);
    }
  }
  return s;
}

function parseDuration(s) {
  if (!s) return null;
  const m = /^(\d+)\s*(m|h|d)$/i.exec(s.trim());
  if (!m) throw new Error(`--since must look like 90m, 24h or 7d (got "${s}")`);
  const mult = { m: 60e3, h: 3600e3, d: 86400e3 }[m[2].toLowerCase()];
  return Date.now() - Number(m[1]) * mult;
}

const fail = (msg) => { process.stderr.write(`error: ${msg}\n`); process.exit(2); };

// Resolve the reader and force the native library to load now, so a broken
// install fails immediately with a useful message rather than part-way through
// a sweep with a cryptic one.
//
// The wrong-platform binary is the common failure: this repo sets
// ignore-scripts, so the upstream postinstall that swaps in a host-matching
// build never runs. That is correct on Linux x64, where the shipped binary is
// already right, and wrong everywhere else — hence `npm run fix-binary`.
async function loadReader({ requireVerification, log }) {
  const { Reader, verifies, why } = await getReader();

  if (!verifies) {
    if (requireVerification) {
      fail(
        `signature verification is unavailable: ${why}\n\n` +
        '  --require-verification was set, so this is a hard failure.\n' +
        '  On macOS or Windows run `npm run fix-binary`.\n' +
        '  On Linux the host C runtime may be too old for the addon; drop\n' +
        '  --require-verification to run unverified, or use a newer host.');
    }
    log('  ! reader   pure-JS fallback — assertions are READ, NOT VERIFIED');
    log(`  !          ${why}`);
    log('  !          results are reported as UNVERIFIED; do not present them');
    log('  !          as verified provenance. --require-verification to refuse.');
  } else {
    log(`  reader   ${why} (signatures verified)`);
  }
  return { Reader, verifies };
}

async function main() {
  const quiet = has('--quiet');
  const log = (m) => { if (!quiet) process.stderr.write(m + '\n'); };

  const dryRun = has('--dry-run');

  // Argument validation before anything that touches the network, so a typo
  // fails in milliseconds rather than after a token exchange.
  if (val('--sort') && val('--since')) {
    fail('--since stops paging at the first asset older than the cutoff, which ' +
         'is only sound under the default newest-first order. Use a created: or ' +
         'updated: clause in --query instead.');
  }
  const sort = validateSort(val('--sort'));

  const schemaName = val('--schema-name');
  const schemaId = val('--schema-id');
  const field = val('--field', 'aiDisclosure');

  if (!dryRun && (!schemaName || !schemaId)) {
    fail('--schema-name and --schema-id are required unless --dry-run. ' +
         'They are DIFFERENT ids for the same schema; see the README.');
  }

  // Auth. Under the Amplience job runner the token arrives as an environment
  // variable rather than an argument, and it is base64-encoded — the daemon
  // does Base64.encodeBase64String(permissionsToken) before handing it to the
  // script wrapper. AMP_SESSION_ID is the refresh token and is not used here.
  let token = val('--token');
  let tokenSource = '--token';
  if (!token && process.env.AMP_SESSION_TOKEN) {
    token = Buffer.from(process.env.AMP_SESSION_TOKEN, 'base64').toString('utf8').trim();
    tokenSource = 'AMP_SESSION_TOKEN';
    if (!token) fail('AMP_SESSION_TOKEN was set but decoded to an empty string');
  }
  if (!token) {
    const authHost = val('--auth-host');
    const clientId = val('--client-id');
    const username = val('--username');
    const password = val('--password');
    if (!(authHost && clientId && username && password)) {
      fail('supply --token, set AMP_SESSION_TOKEN, or pass all of ' +
           '--auth-host --client-id --username --password');
    }
    token = await AmplienceClient.tokenFromPassword({ authHost, clientId, username, password });
    tokenSource = 'password grant';
  }

  const client = new AmplienceClient({
    token,
    damHost: val('--dam-host', 'https://dam-api.amplience.net/v1.5.0'),
    log,
  });

  const readerInfo = await loadReader({ requireVerification: has('--require-verification'), log });

  const noTrust = has('--no-trust');
  const opts = {
    client,
    Reader: readerInfo.Reader,
    bucket: val('--bucket'),
    query: resolveQuery(),
    sort,
    limit: val('--limit') ? Number(val('--limit')) : Infinity,
    since: parseDuration(val('--since')),
    schemaName, schemaId, field,
    versionField: val('--version-field'),
    concurrency: Number(val('--concurrency', '4')),
    dryRun,
    force: has('--force'),
    publish: !has('--no-publish'),
    reason: val('--reason', 'c2pa-disclosure'),
    anchorsPath: noTrust ? null : val('--trust-anchors', DEFAULT_ANCHORS),
    allowedPath: noTrust ? null : val('--allowed-list', DEFAULT_ALLOWED),
    log,
  };

  log(`c2pa-disclosure${dryRun ? ' (dry run)' : ''}`);
  log(`  auth   ${tokenSource}`);
  if (opts.bucket) log(`  bucket ${opts.bucket}`);
  if (opts.query) log(`  query  ${opts.query}`);
  if (opts.sort) log(`  sort   ${opts.sort}`);

  // Without --bucket the search covers every bucket this user can READ — not
  // every bucket in the account. A user with no bucket permissions gets a 200
  // and an empty page, so the job would report success having examined
  // nothing. Say what is in scope, and refuse the empty case outright.
  if (!opts.bucket) {
    let names = null;
    try {
      names = (await client.buckets()).map((b) => b.name ?? b.label ?? b.id);
    } catch (e) {
      log(`  scope  all readable buckets (could not list them: ${e.message})`);
    }
    if (names) {
      if (names.length === 0) {
        fail('this user has READ on no buckets, so the search can only ever ' +
             'return nothing. Grant bucket permissions, or pass --bucket.');
      }
      log(`  scope  ${names.length} bucket(s): ${names.join(', ')}`);
    }
  }

  const t0 = Date.now();
  const { results, published, candidates, trustEnabled } = await run(opts);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const jsonPath = val('--json');
  if (jsonPath) {
    fs.writeFileSync(jsonPath, results.map((r) => JSON.stringify(r)).join('\n') + '\n');
    log(`  wrote ${jsonPath}`);
  }

  const tally = (key) => results.reduce((m, r) => m.set(r[key] ?? '-', (m.get(r[key] ?? '-') ?? 0) + 1), new Map());
  const show = (label, m) => {
    console.log(`\n${label}`);
    for (const [k, n] of [...m].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
  };

  console.log(`\n${'='.repeat(58)}`);
  console.log(`candidates ${candidates}   processed ${results.length}   ${secs}s`);
  console.log(`trust list ${trustEnabled ? 'enabled' : 'DISABLED — nothing can reach Trusted'}`);
  show('ACTION', tally('action'));
  const classified = results.filter((r) => r.disclosure && r.action !== 'skipped-existing');
  if (classified.length) {
    show('DISCLOSURE', classified.reduce((m, r) => m.set(r.disclosure, (m.get(r.disclosure) ?? 0) + 1), new Map()));
    show('VALIDATION', classified.reduce((m, r) => m.set(r.validationState ?? 'NONE', (m.get(r.validationState ?? 'NONE') ?? 0) + 1), new Map()));
  }
  const gens = results.filter((r) => r.claimGenerator);
  if (gens.length) show(`CLAIM GENERATORS (${gens.length} with credentials)`,
    gens.reduce((m, r) => m.set(r.claimGenerator, (m.get(r.claimGenerator) ?? 0) + 1), new Map()));

  // Where each source type was found. Anything other than 'spec' means a
  // vendor used a non-standard location — worth knowing, since reading only the
  // spec location silently under-reports those assets.
  const vias = [...new Set(results.flatMap((r) => r.sourceTypeVia ?? []))].filter((v) => v && v !== 'spec');
  if (vias.length) console.log(`\nNON-STANDARD digitalSourceType LOCATIONS\n  ${vias.join('\n  ')}`);

  // Credentials present, generator named, but no source type found anywhere.
  // Either genuinely not AI, or a vendor placement this tool does not know.
  const puzzling = results.filter((r) => r.noSourceType && r.claimGenerator);
  if (puzzling.length) {
    console.log(`\nNO SOURCE TYPE FOUND  (${puzzling.length})`);
    console.log('  These carry credentials but assert no digitalSourceType in any known');
    console.log('  location. Usually genuinely not AI — but if a generator below is one');
    console.log('  you expect to be generative, it may use a placement this tool misses.');
    for (const [g, n] of [...puzzling.reduce((m, r) => m.set(r.claimGenerator, (m.get(r.claimGenerator) ?? 0) + 1), new Map())])
      console.log(`    ${String(n).padStart(4)}  ${g}`);
  }

  // Invalid does not imply tampering — certificates expire while content stays
  // intact. Split the two so an operator can tell them apart at a glance.
  const invalid = results.filter((r) => r.validationState === 'Invalid');
  if (invalid.length) {
    console.log(`\nINVALID (${invalid.length})`);
    console.log(`  ${invalid.filter((r) => r.integrityFailure).length} integrity failure — bytes changed since signing`);
    console.log(`  ${invalid.filter((r) => !r.integrityFailure).length} other, e.g. expired certificate — content may be intact`);
  }

  if (published) console.log(`\npublished ${published} asset(s)`);

  const errors = results.filter((r) => r.action === 'error');
  if (errors.length) {
    console.log(`\nERRORS ${errors.length}`);
    for (const r of errors.slice(0, 10)) console.log(`  ${r.assetId}  ${r.error}`);
    process.exitCode = 1;
  }
  console.log('');
}

main().catch((e) => { process.stderr.write(`\nFATAL: ${e.message}\n`); process.exit(1); });
