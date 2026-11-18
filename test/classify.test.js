'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { classify, validationSummary, DISCLOSURE } = require('../lib/classify');

const IPTC = 'http://cv.iptc.org/newscodes/digitalsourcetype';

// Minimal manifest store in the shape c2pa-rs emits.
function store(actions, { extraManifests = {}, validationState, failures } = {}) {
  return {
    active_manifest: 'active',
    manifests: {
      active: {
        claim_generator_info: [{ name: 'Test Generator' }],
        assertions: [{ label: 'c2pa.actions', data: { actions } }],
      },
      ...extraManifests,
    },
    ...(validationState ? { validation_state: validationState } : {}),
    ...(failures ? { validation_results: { activeManifest: { failure: failures } } } : {}),
  };
}

test('no store at all is unknown, not none', () => {
  assert.equal(classify(null).disclosure, DISCLOSURE.UNKNOWN);
  assert.equal(classify({}).disclosure, DISCLOSURE.UNKNOWN);
  assert.equal(classify({ manifests: {} }).disclosure, DISCLOSURE.UNKNOWN);
});

test('created as trainedAlgorithmicMedia is fullyGenerated', () => {
  const r = classify(store([
    { action: 'c2pa.created', digitalSourceType: `${IPTC}/trainedAlgorithmicMedia` },
  ]));
  assert.equal(r.disclosure, DISCLOSURE.FULLY);
  assert.equal(r.evidence.claimGenerator, 'Test Generator');
});

// Both spellings occur in the wild; a miss would fail toward "not AI".
for (const leaf of ['compositedWithTrainedAlgorithmicMedia', 'compositeWithTrainedAlgorithmicMedia']) {
  test(`composite source type ${leaf} is partiallyModified`, () => {
    const r = classify(store([
      { action: 'c2pa.created', digitalSourceType: `${IPTC}/digitalCapture` },
      { action: 'c2pa.placed', digitalSourceType: `${IPTC}/${leaf}` },
    ]));
    assert.equal(r.disclosure, DISCLOSURE.PARTIAL);
    assert.deepEqual(r.evidence.spellings, [leaf]);
  });
}

test('trainedAlgorithmicMedia on an edit is partiallyModified, not fullyGenerated', () => {
  const r = classify(store([
    { action: 'c2pa.created', digitalSourceType: `${IPTC}/digitalCapture` },
    { action: 'c2pa.edited', digitalSourceType: `${IPTC}/trainedAlgorithmicMedia` },
  ]));
  assert.equal(r.disclosure, DISCLOSURE.PARTIAL);
});

test('a real capture with no AI source type is none', () => {
  const r = classify(store([
    { action: 'c2pa.created', digitalSourceType: `${IPTC}/digitalCapture` },
    { action: 'c2pa.color_adjustments' },
  ]));
  assert.equal(r.disclosure, DISCLOSURE.NONE);
});

test('generation wins over later edits', () => {
  const r = classify(store([
    { action: 'c2pa.created', digitalSourceType: `${IPTC}/trainedAlgorithmicMedia` },
    { action: 'c2pa.edited', digitalSourceType: `${IPTC}/digitalCapture` },
  ]));
  assert.equal(r.disclosure, DISCLOSURE.FULLY);
});

// An AI ingredient composited into an ordinary photo lives in the ingredient's
// manifest, not the active one.
test('AI in a non-active manifest still counts', () => {
  const r = classify(store(
    [{ action: 'c2pa.created', digitalSourceType: `${IPTC}/digitalCapture` }],
    {
      extraManifests: {
        ingredient: {
          assertions: [{
            label: 'c2pa.actions',
            data: { actions: [{ action: 'c2pa.created', digitalSourceType: `${IPTC}/trainedAlgorithmicMedia` }] },
          }],
        },
      },
    }));
  assert.equal(r.disclosure, DISCLOSURE.FULLY);
  assert.equal(r.evidence.manifestCount, 2);
});

test('versioned actions label is still recognised', () => {
  const s = store([]);
  s.manifests.active.assertions = [{
    label: 'c2pa.actions.v2',
    data: { actions: [{ action: 'c2pa.created', digitalSourceType: `${IPTC}/trainedAlgorithmicMedia` }] },
  }];
  assert.equal(classify(s).disclosure, DISCLOSURE.FULLY);
});

test('manifest with no actions assertion is none', () => {
  const s = store([]);
  s.manifests.active.assertions = [{ label: 'stds.schema-org.CreativeWork', data: {} }];
  assert.equal(classify(s).disclosure, DISCLOSURE.NONE);
});

test('validationSummary reports NONE for an absent store', () => {
  assert.deepEqual(validationSummary(null), { state: 'NONE', failures: [], integrityFailure: false });
});

test('expired certificate is not an integrity failure', () => {
  const s = store([], {
    validationState: 'Invalid',
    failures: [{ code: 'signingCredential.expired' }],
  });
  const v = validationSummary(s);
  assert.equal(v.state, 'Invalid');
  assert.equal(v.integrityFailure, false, 'expiry must not be read as tampering');
});

test('hash mismatch is an integrity failure', () => {
  const s = store([], {
    validationState: 'Invalid',
    failures: [{ code: 'assertion.dataHash.mismatch' }],
  });
  assert.equal(validationSummary(s).integrityFailure, true);
});

test('failure codes are de-duplicated', () => {
  const s = store([], {
    validationState: 'Valid',
    failures: [{ code: 'signingCredential.untrusted' }, { code: 'signingCredential.untrusted' }],
  });
  assert.deepEqual(validationSummary(s).failures, ['signingCredential.untrusted']);
});

// Real files do not always put digitalSourceType where the spec says. Adobe
// Firefly, routing to a third-party model, omits the standard field entirely
// and nests the value in a vendor-namespaced parameter. Reading only the spec
// location reported a genuine text-to-image export as `none`.
test('vendor-namespaced digitalSourceType is found', () => {
  const r = classify(store([{
    action: 'c2pa.opened',
    parameters: {
      'com.adobe.type': 'remoteProvider.3rdParty',
      'com.adobe.modelId': 'gemini-flash',
      'com.adobe.digitalSourceType': `${IPTC}/trainedAlgorithmicMedia`,
    },
  }]));
  assert.equal(r.disclosure, DISCLOSURE.FULLY);
  assert.deepEqual(r.evidence.sourceTypeVia, ['com.adobe.digitalSourceType']);
});

test('the spec field wins when both are present', () => {
  const r = classify(store([{
    action: 'c2pa.created',
    digitalSourceType: `${IPTC}/digitalCapture`,
    parameters: { 'com.adobe.digitalSourceType': `${IPTC}/trainedAlgorithmicMedia` },
  }]));
  assert.equal(r.disclosure, DISCLOSURE.NONE);
  assert.deepEqual(r.evidence.sourceTypeVia, ['spec']);
});

test('any vendor namespace is matched, not just Adobe', () => {
  const r = classify(store([{
    action: 'c2pa.created',
    parameters: { 'io.example.digitalSourceType': `${IPTC}/trainedAlgorithmicMedia` },
  }]));
  assert.equal(r.disclosure, DISCLOSURE.FULLY);
});

test('unrelated vendor parameters are ignored', () => {
  const r = classify(store([{
    action: 'c2pa.created',
    parameters: { 'com.adobe.modelId': 'gemini-flash', 'com.adobe.details': 'Gemini Flash' },
  }]));
  assert.equal(r.disclosure, DISCLOSURE.NONE);
  assert.deepEqual(r.evidence.sourceTypeVia, []);
});
