'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { run } = require('../lib/run');

const CLI = path.join(__dirname, '..', 'bin', 'c2pa-disclosure.js');

// Captures whatever searchAssets was called with, so the sort value can be
// asserted on where it actually matters: the request.
function recordingClient() {
  const seen = [];
  return {
    seen,
    async *searchAssets(args) { seen.push(args); },
    async asset() { return null; },
    async assetMetadata() { return {}; },
  };
}

const base = {
  Reader: {}, schemaName: 's', schemaId: 'i', field: 'f', concurrency: 1, dryRun: true,
};

test('sort is passed through to the search request', async () => {
  const client = recordingClient();
  await run({ ...base, client, sort: 'updated:asc' });
  assert.equal(client.seen[0].sort, 'updated:asc');
});

test('no sort leaves the parameter off entirely', async () => {
  const client = recordingClient();
  await run({ ...base, client });
  assert.equal(client.seen[0].sort, null);
});

// The CLI rejects the shapes that produce an opaque server-side 500, so the
// failure names the offending argument instead.
function cliError(args) {
  try {
    execFileSync(process.execPath, [CLI, '--dry-run', ...args], { stdio: 'pipe' });
    return null;
  } catch (e) {
    return e.stderr.toString();
  }
}

test("Solr's native sort syntax is refused with the correct form", () => {
  const err = cliError(['--sort', 'created desc']);
  assert.match(err, /created:desc/);
});

test('a metadata field as a sort key is refused', () => {
  const err = cliError(['--sort', 'versionedAiDisclosure.analysedVersion:desc']);
  assert.match(err, /only asset fields are sortable/);
});

test('the fields the API forbids are refused locally', () => {
  assert.match(cliError(['--sort', 'srcName:asc']), /refused by the DAM API/);
  assert.match(cliError(['--sort', 'file:desc']), /refused by the DAM API/);
});

test('a bad direction is refused', () => {
  assert.match(cliError(['--sort', 'updated:sideways']), /must be asc or desc/);
});

test('dotted asset fields are allowed through', () => {
  // No token is supplied, so this still fails — the point is that it gets past
  // sort validation and falls over on auth instead.
  const err = cliError(['--sort', 'lastSuccess.timestamp:desc,ID:desc']);
  assert.doesNotMatch(err, /--sort/);
  assert.match(err, /supply --token/);
});

test('--sort and --since together are refused', () => {
  assert.match(cliError(['--sort', 'updated:asc', '--since', '2h']), /--since stops paging/);
});

test('an unrecognised flag is refused rather than ignored', () => {
  const err = cliError(['--pubish']);
  assert.match(err, /unrecognised argument\(s\): --pubish/);
});

test('--publish is accepted, since it is what publishing already does', () => {
  assert.doesNotMatch(cliError(['--publish']), /unrecognised/);
});

// Account-wide runs are scoped by the user's bucket permissions, not by the
// account, and a user with none gets a 200 with an empty page. That would be a
// silent no-op, so the CLI refuses it. Served locally to exercise the real
// path rather than a connection error.
function withBucketServer(buckets, fn) {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/v1.5.0/buckets')) {
      res.end(JSON.stringify({ content: { data: buckets } }));
    } else {
      res.end(JSON.stringify({ content: { data: [], numFound: 0 } }));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', async () => {
      const host = `http://127.0.0.1:${server.address().port}/v1.5.0`;
      try { resolve(await fn(host)); } finally { server.close(); }
    });
  });
}

// Must not be execFileSync: that blocks the event loop, so the stub server
// above could never answer the request the child is waiting on.
function cliRun(args) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args]);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ ok: code === 0, out }));
  });
}

test('a user with no readable buckets is refused, not reported as zero work', async () => {
  const r = await withBucketServer([], (host) =>
    cliRun(['--token', 'x', '--dam-host', host, '--no-trust', '--dry-run']));
  assert.equal(r.ok, false);
  assert.match(r.out, /READ on no buckets/);
});

test('an account-wide run names the buckets it will cover', async () => {
  const r = await withBucketServer([{ name: 'Assets' }, { name: 'Bucket 2' }], (host) =>
    cliRun(['--token', 'x', '--dam-host', host, '--no-trust', '--dry-run']));
  assert.match(r.out, /scope  2 bucket\(s\): Assets, Bucket 2/);
});

test('naming a bucket skips the scope check entirely', async () => {
  const r = await withBucketServer([], (host) =>
    cliRun(['--token', 'x', '--dam-host', host, '--no-trust', '--dry-run', '--bucket', 'b']));
  assert.doesNotMatch(r.out, /READ on no buckets/);
});
