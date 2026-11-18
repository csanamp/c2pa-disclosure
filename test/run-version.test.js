'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { run } = require('../lib/run');
const { SCHEMA_IDS } = require('../lib/amplience');

const IPTC = 'http://cv.iptc.org/newscodes/digitalsourcetype';
const SCHEMA = 'versionedAiDisclosure';

// A manifest store shaped as c2pa-rs emits, carrying whatever verdict a test
// needs. Byte content is irrelevant here; the fake Reader keys off it.
function storeFor(sourceType) {
  return {
    active_manifest: 'm',
    manifests: {
      m: {
        claim_generator: 'Test',
        assertions: [{
          label: 'c2pa.actions',
          data: { actions: [{ action: 'c2pa.created', digitalSourceType: `${IPTC}/${sourceType}` }] },
        }],
      },
    },
    validation_state: 'Trusted',
  };
}

// In-memory stand-in for the DAM, modelling the revision behaviour that
// actually matters and that cost a debugging cycle to find:
//
//   attachMetadataSchema  bumps the revision on EVERY call, attached or not
//   publishAssets         bumps the revision
//   writeMetadata         does NOT bump the revision
//
// Anything less faithful hides the bug where the revision outruns the recorded
// version forever and nothing ever settles.
function fakeClient({ assets, metadata = {}, bytes = {}, attachedSchemas = {} }) {
  const calls = { downloads: [], writes: [], publishes: [], attaches: [] };
  const byId = new Map(assets.map((a) => [a.id, { publishStatus: 'PUBLISHED', ...a }]));
  const attached = new Map(Object.entries(attachedSchemas).map(([k, v]) => [k, new Set(v)]));

  return {
    calls, byId,
    async *searchAssets() { for (const a of byId.values()) yield a; },
    async asset(id) { return byId.get(id); },
    async assetMetadata(id) {
      const out = { ...(metadata[id] ?? {}) };
      Object.defineProperty(out, SCHEMA_IDS, {
        value: attached.get(id) ?? new Set(), enumerable: false,
      });
      return out;
    },
    async downloadOriginal(id) { calls.downloads.push(id); return Buffer.from(bytes[id] ?? 'none'); },
    async attachMetadataSchema({ assetId }) {
      calls.attaches.push(assetId);
      byId.get(assetId).revisionNumber += 1;
      if (!attached.has(assetId)) attached.set(assetId, new Set());
      attached.get(assetId).add('sid');
    },
    async writeMetadata({ assetId, values }) {
      calls.writes.push({ assetId, values });
      metadata[assetId] = { [SCHEMA]: values };
    },
    async publishAssets(ids) {
      calls.publishes.push(...ids);
      for (const id of ids) { byId.get(id).revisionNumber += 1; byId.get(id).publishStatus = 'PUBLISHED'; }
    },
  };
}

// Reader whose verdict is driven by the buffer contents, so a test can simulate
// an asset's bytes being replaced.
const FakeReader = {
  async fromAsset({ buffer }) {
    const kind = buffer.toString();
    if (kind === 'nomanifest') return null;
    const store = storeFor(kind === 'ai' ? 'trainedAlgorithmicMedia' : 'digitalCapture');
    return { json: () => store, isEmbedded: () => true, remoteUrl: () => null };
  },
};

const base = {
  Reader: FakeReader,
  schemaName: 'sname', schemaId: 'sid',
  field: 'versionedAiDisclosure', versionField: 'analysedVersion',
  concurrency: 1, publish: true,
};


test('an asset already analysed at its current revision is skipped', async () => {
  const client = fakeClient({
    assets: [{ id: 'a', name: 'a', type: 'image', status: 'active', revisionNumber: 4 }],
    metadata: { a: { [SCHEMA]: { versionedAiDisclosure: 'none', analysedVersion: 4 } } },
    attachedSchemas: { a: ['sid'] },
  });
  const { results } = await run({ ...base, client });
  assert.equal(results[0].action, 'skipped-current');
  assert.equal(client.calls.downloads.length, 0, 'must not pay for a download it does not need');
});

// The bypass this whole mechanism exists to close.
test('an asset whose bytes were replaced is re-analysed despite holding a value', async () => {
  const client = fakeClient({
    // classified at revision 4 as `none`; now at revision 5 with AI content
    assets: [{ id: 'a', name: 'a', type: 'image', status: 'active', revisionNumber: 5 }],
    metadata: { a: { [SCHEMA]: { versionedAiDisclosure: 'none', analysedVersion: 4 } } },
    attachedSchemas: { a: ['sid'] },
    bytes: { a: 'ai' },
  });
  const { results } = await run({ ...base, client });
  assert.equal(results[0].action, 'written');
  assert.equal(results[0].disclosure, 'fullyGenerated');
  assert.equal(results[0].previousDisclosure, 'none');
  assert.deepEqual(client.calls.writes[0].values,
    { versionedAiDisclosure: 'fullyGenerated', analysedVersion: 5 });
  assert.deepEqual(client.calls.publishes, ['a'], 'a changed verdict must be published');
});

// Publishing bumps the revision, which would otherwise read as a new revision
// needing analysis on the next run, forever.
test('an unchanged verdict updates the version but does not publish', async () => {
  const client = fakeClient({
    assets: [{ id: 'a', name: 'a', type: 'image', status: 'active', revisionNumber: 6 }],
    metadata: { a: { [SCHEMA]: { versionedAiDisclosure: 'none', analysedVersion: 5 } } },
    attachedSchemas: { a: ['sid'] },
    bytes: { a: 'camera' },
  });
  const { results, published } = await run({ ...base, client });
  assert.equal(results[0].action, 'written');
  assert.equal(results[0].disclosure, 'none');
  assert.equal(client.calls.writes[0].values.analysedVersion, 6, 'version must advance');
  assert.deepEqual(client.calls.publishes, [], 'no publish, so no revision bump, so no loop');
  assert.equal(published, 0);
});

test('an asset never analysed is processed, and records the POST-attach revision', async () => {
  const client = fakeClient({
    assets: [{ id: 'a', name: 'a', type: 'image', status: 'active', revisionNumber: 1 }],
    bytes: { a: 'ai' },
  });
  const { results } = await run({ ...base, client });
  assert.equal(results[0].action, 'written');
  assert.deepEqual(client.calls.attaches, ['a'], 'schema was missing, so attach once');
  // The attach itself moved the asset to revision 2. Recording the revision as
  // seen at search time would leave 1 < 2 forever.
  assert.equal(client.calls.writes[0].values.analysedVersion, 2);
});

test('the schema is not re-attached when it is already there', async () => {
  const client = fakeClient({
    assets: [{ id: 'a', name: 'a', type: 'image', status: 'active', revisionNumber: 7 }],
    metadata: { a: { [SCHEMA]: { versionedAiDisclosure: 'none', analysedVersion: 6 } } },
    attachedSchemas: { a: ['sid'] },
    bytes: { a: 'camera' },
  });
  await run({ ...base, client });
  assert.deepEqual(client.calls.attaches, [], 'attach bumps the revision; do not call it needlessly');
  assert.equal(client.byId.get('a').revisionNumber, 7, 'revision must not move');
  assert.equal(client.calls.writes[0].values.analysedVersion, 7);
});

// The whole point of the previous test: without it the revision outruns the
// recorded version on every run and the job re-downloads everything forever.
test('a settled asset stays settled across repeated runs', async () => {
  const meta = {};
  const assets = [{ id: 'a', name: 'a', type: 'image', status: 'active', revisionNumber: 1 }];
  const attachedSchemas = {};
  const mk = () => {
    const c = fakeClient({ assets, metadata: meta, attachedSchemas, bytes: { a: 'camera' } });
    const origAttach = c.attachMetadataSchema;
    c.attachMetadataSchema = async (args) => {
      await origAttach(args);
      attachedSchemas.a = ['sid'];
      assets[0].revisionNumber = c.byId.get('a').revisionNumber;
    };
    return c;
  };
  const r1 = mk(); await run({ ...base, client: r1 });
  assert.deepEqual(r1.calls.attaches, ['a']);

  for (const runNo of [2, 3, 4]) {
    const c = mk();
    const { results } = await run({ ...base, client: c });
    assert.equal(results[0].action, 'skipped-current', `run ${runNo} must skip`);
    assert.equal(c.calls.downloads.length, 0, `run ${runNo} must not download`);
    assert.deepEqual(c.calls.attaches, [], `run ${runNo} must not attach`);
  }
});

// Analysing unpublished assets closes the gap where a customer publishes
// between runs and the image is briefly live without a label. Publishing them
// would release the customer's content for them, which is not the job's call.
test('an unpublished asset is labelled but never published', async () => {
  const client = fakeClient({
    assets: [{ id: 'a', name: 'a', type: 'image', status: 'active', revisionNumber: 1,
               publishStatus: 'NOT_PUBLISHED' }],
    bytes: { a: 'ai' },
  });
  const { results, published, heldBack } = await run({ ...base, client });
  assert.equal(results[0].action, 'written');
  assert.equal(results[0].disclosure, 'fullyGenerated');
  assert.equal(client.calls.writes.length, 1, 'the label is written');
  assert.deepEqual(client.calls.publishes, [], 'but the asset stays unpublished');
  assert.equal(published, 0);
  assert.equal(heldBack, 1);
  assert.equal(client.byId.get('a').publishStatus, 'NOT_PUBLISHED');
});

test('an asset mid-publish is left for the next run', async () => {
  const client = fakeClient({
    assets: [{ id: 'a', name: 'a', type: 'image', status: 'active', revisionNumber: 1,
               publishStatus: 'PUBLISH_IN_PROGRESS' }],
    bytes: { a: 'ai' },
  });
  await run({ ...base, client });
  assert.deepEqual(client.calls.publishes, []);
});

test('a published asset with a changed verdict is still published', async () => {
  const client = fakeClient({
    assets: [{ id: 'a', name: 'a', type: 'image', status: 'active', revisionNumber: 5,
               publishStatus: 'PUBLISHED' }],
    metadata: { a: { [SCHEMA]: { versionedAiDisclosure: 'none', analysedVersion: 4 } } },
    attachedSchemas: { a: ['sid'] },
    bytes: { a: 'ai' },
  });
  const { published } = await run({ ...base, client });
  assert.deepEqual(client.calls.publishes, ['a']);
  assert.equal(published, 1);
});

test('--force re-analyses even when the version is current', async () => {
  const client = fakeClient({
    assets: [{ id: 'a', name: 'a', type: 'image', status: 'active', revisionNumber: 4 }],
    metadata: { a: { [SCHEMA]: { versionedAiDisclosure: 'none', analysedVersion: 4 } } },
    attachedSchemas: { a: ['sid'] },
    bytes: { a: 'ai' },
  });
  const { results } = await run({ ...base, client, force: true });
  assert.equal(results[0].action, 'written');
  assert.equal(results[0].disclosure, 'fullyGenerated');
  assert.deepEqual(client.calls.attaches, [], 'force must not re-attach an attached schema');
});

// --force means "ignore the recorded version", not "ignore what is stored".
test('--force on an unchanged verdict does not republish', async () => {
  const client = fakeClient({
    assets: [{ id: 'a', name: 'a', type: 'image', status: 'active', revisionNumber: 4 }],
    metadata: { a: { [SCHEMA]: { versionedAiDisclosure: 'none', analysedVersion: 4 } } },
    attachedSchemas: { a: ['sid'] },
    bytes: { a: 'camera' },
  });
  const { results } = await run({ ...base, client, force: true });
  assert.equal(results[0].previousDisclosure, 'none', 'stored value must still be read');
  assert.deepEqual(client.calls.publishes, [], 'nothing changed, so nothing to publish');
});

test('without a version field the old skip-existing behaviour is kept', async () => {
  const client = fakeClient({
    assets: [{ id: 'a', name: 'a', type: 'image', status: 'active', revisionNumber: 9 }],
    metadata: { a: { aidisclosure: { aiDisclosure: 'none' } } },
    attachedSchemas: { a: ['sid'] },
  });
  const { results } = await run({
    ...base, client, versionField: null, field: 'aiDisclosure',
  });
  assert.equal(results[0].action, 'skipped-existing');
  assert.equal(client.calls.downloads.length, 0);
});

test('a dry run writes and publishes nothing', async () => {
  const client = fakeClient({
    assets: [{ id: 'a', name: 'a', type: 'image', status: 'active', revisionNumber: 2 }],
    bytes: { a: 'ai' },
  });
  const { results } = await run({ ...base, client, dryRun: true });
  assert.equal(results[0].action, 'dry-run');
  assert.equal(results[0].disclosure, 'fullyGenerated');
  assert.equal(client.calls.writes.length, 0);
  assert.equal(client.calls.publishes.length, 0);
});

// Converging behaviour over successive runs, which is what stops the treadmill.
test('a changed verdict settles after one follow-up run', async () => {
  let revision = 5;
  const meta = { a: { [SCHEMA]: { versionedAiDisclosure: 'none', analysedVersion: 4 } } };
  const mk = () => {
    const c = fakeClient({
      assets: [{ id: 'a', name: 'a', type: 'image', status: 'active', revisionNumber: revision }],
      metadata: meta, attachedSchemas: { a: ['sid'] }, bytes: { a: 'ai' },
    });
    const origWrite = c.writeMetadata;
    c.writeMetadata = async (args) => { await origWrite(args); meta.a[SCHEMA] = args.values; };
    const origPub = c.publishAssets;
    c.publishAssets = async (ids) => { await origPub(ids); revision += 1; };  // publish bumps
    return c;
  };

  const r1 = mk(); await run({ ...base, client: r1 });
  assert.deepEqual(r1.calls.publishes, ['a'], 'run 1 publishes the changed verdict');
  assert.equal(revision, 6, 'publish bumped the revision');

  const r2 = mk(); const out2 = await run({ ...base, client: r2 });
  assert.equal(out2.results[0].action, 'written', 'run 2 re-analyses the bumped revision');
  assert.deepEqual(r2.calls.publishes, [], 'verdict unchanged, so no publish, so no further bump');

  const r3 = mk(); const out3 = await run({ ...base, client: r3 });
  assert.equal(out3.results[0].action, 'skipped-current', 'run 3 settles');
  assert.equal(r3.calls.downloads.length, 0);
});
