'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { readManifestStore, extractJumbf } = require('../lib/manifest');
const { classify, DISCLOSURE } = require('../lib/classify');

const IPTC = 'http://cv.iptc.org/newscodes/digitalsourcetype';

// ── Minimal CBOR encoder, test-only ──────────────────────────────────────────
// Just enough to build fixtures; the library itself is decode-only.
function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b;
  };
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, s.length), s]); }
  if (typeof v === 'number') return head(0, v);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    return Buffer.concat([head(5, keys.length), ...keys.flatMap((k) => [cbor(k), cbor(v[k])])]);
  }
  throw new Error('unsupported test value');
}

// ── JUMBF builders ───────────────────────────────────────────────────────────
function box(type, payload) {
  const b = Buffer.alloc(8);
  b.writeUInt32BE(payload.length + 8, 0);
  b.write(type, 4, 'latin1');
  return Buffer.concat([b, payload]);
}

function jumd(label) {
  const uuid = Buffer.alloc(16);
  const toggles = Buffer.from([0x03]);                 // requestable + label present
  return box('jumd', Buffer.concat([uuid, toggles, Buffer.from(label + '\0', 'utf8')]));
}

const superbox = (label, ...children) => box('jumb', Buffer.concat([jumd(label), ...children]));
const cborBox = (label, value) => superbox(label, box('cbor', cbor(value)));

function manifestStore(manifestLabel, actions, generator = 'Test Gen') {
  return superbox('c2pa',
    superbox(manifestLabel,
      superbox('c2pa.assertions', cborBox('c2pa.actions', { actions })),
      cborBox('c2pa.claim', { claim_generator: generator, claim_generator_info: [{ name: generator }] })));
}

// ── Containers ───────────────────────────────────────────────────────────────
function png(jumbf) {
  const sig = Buffer.from('89504e470d0a1a0a', 'hex');
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([sig, chunk('IHDR', Buffer.alloc(13)), chunk('caBX', jumbf), chunk('IEND', Buffer.alloc(0))]);
}

// Splits the JUMBF across APP11 segments to exercise reassembly.
function jpeg(jumbf, chunkSize = Infinity) {
  const parts = [Buffer.from([0xFF, 0xD8])];
  let seq = 1;
  for (let off = 0; off < jumbf.length; off += chunkSize) {
    const body = jumbf.subarray(off, Math.min(off + chunkSize, jumbf.length));
    // Real encoders repeat the box's LBox+TBox on every packet.
    const slice = off === 0 ? body : Buffer.concat([jumbf.subarray(0, 8), body]);
    const hdr = Buffer.alloc(8);
    hdr.write('JP', 0, 'latin1');
    hdr.writeUInt16BE(1, 2);                            // box instance
    hdr.writeUInt32BE(seq++, 4);                        // packet sequence
    const payload = Buffer.concat([hdr, slice]);
    const seg = Buffer.alloc(4);
    seg[0] = 0xFF; seg[1] = 0xEB;
    seg.writeUInt16BE(payload.length + 2, 2);
    parts.push(seg, payload);
  }
  parts.push(Buffer.from([0xFF, 0xDA]));                // start of scan
  return Buffer.concat(parts);
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('reads a manifest from a PNG caBX chunk', () => {
  const buf = png(manifestStore('urn:uuid:test',
    [{ action: 'c2pa.created', digitalSourceType: `${IPTC}/trainedAlgorithmicMedia` }], 'Adobe Firefly'));
  const store = readManifestStore(buf);
  assert.equal(store.active_manifest, 'urn:uuid:test');
  assert.equal(classify(store).disclosure, DISCLOSURE.FULLY);
  assert.equal(classify(store).evidence.claimGenerator, 'Adobe Firefly');
});

test('reads a manifest from a single-segment JPEG', () => {
  const buf = jpeg(manifestStore('urn:uuid:j',
    [{ action: 'c2pa.created', digitalSourceType: `${IPTC}/trainedAlgorithmicMedia` }]));
  assert.equal(classify(readManifestStore(buf)).disclosure, DISCLOSURE.FULLY);
});

// A manifest larger than one APP11 segment is split; the reader must
// reassemble by packet sequence or it sees a truncated box.
test('reassembles a JPEG manifest split across APP11 segments', () => {
  const jumbf = manifestStore('urn:uuid:multi',
    [{ action: 'c2pa.created', digitalSourceType: `${IPTC}/trainedAlgorithmicMedia` }]);
  const buf = jpeg(jumbf, 40);
  assert.ok(jumbf.length > 40 * 2, 'fixture should span several segments');
  assert.equal(classify(readManifestStore(buf)).disclosure, DISCLOSURE.FULLY);
});

test('always reports UNVERIFIED — this path checks no signatures', () => {
  const store = readManifestStore(png(manifestStore('urn:uuid:x',
    [{ action: 'c2pa.created', digitalSourceType: `${IPTC}/trainedAlgorithmicMedia` }])));
  assert.equal(store.validation_state, 'UNVERIFIED');
});

test('a real capture is classified none, not unknown', () => {
  const store = readManifestStore(png(manifestStore('urn:uuid:cam',
    [{ action: 'c2pa.created', digitalSourceType: `${IPTC}/digitalCapture` }])));
  assert.equal(classify(store).disclosure, DISCLOSURE.NONE);
});

test('composited AI is partiallyModified', () => {
  const store = readManifestStore(png(manifestStore('urn:uuid:comp', [
    { action: 'c2pa.created', digitalSourceType: `${IPTC}/digitalCapture` },
    { action: 'c2pa.placed', digitalSourceType: `${IPTC}/compositedWithTrainedAlgorithmicMedia` },
  ])));
  assert.equal(classify(store).disclosure, DISCLOSURE.PARTIAL);
});

test('assets without a manifest return null, and classify as unknown', () => {
  assert.equal(readManifestStore(png(Buffer.alloc(0))), null);
  assert.equal(readManifestStore(Buffer.from('not an image at all')), null);
  assert.equal(readManifestStore(Buffer.alloc(0)), null);
  assert.equal(classify(readManifestStore(Buffer.from('nope'))).disclosure, DISCLOSURE.UNKNOWN);
});

test('malformed boxes are survived rather than thrown', () => {
  // Declares a box far longer than the buffer actually is.
  const bogus = Buffer.alloc(16);
  bogus.writeUInt32BE(0xFFFFFF, 0);
  bogus.write('jumb', 4, 'latin1');
  assert.doesNotThrow(() => readManifestStore(png(bogus)));
  assert.equal(readManifestStore(png(bogus)), null);
});

test('extractJumbf recognises PNG and JPEG, and rejects other bytes', () => {
  const jumbf = manifestStore('urn:uuid:e', [{ action: 'c2pa.created' }]);
  assert.ok(extractJumbf(png(jumbf)));
  assert.ok(extractJumbf(jpeg(jumbf)));
  assert.equal(extractJumbf(Buffer.from('GIF89a-not-supported')), null);
});
