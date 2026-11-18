'use strict';

// Pure-JavaScript C2PA manifest reader.
//
// A fallback for hosts where the native addon cannot load. The Amplience
// processing-job runner is one: its image is CentOS/RHEL 7 era (glibc ~2.17,
// libstdc++ capped at GLIBCXX_3.4.19) while every published build of
// @contentauth/c2pa-node needs glibc 2.34 and GLIBCXX_3.4.29. That gap cannot
// be bridged by choosing an older release — all of them are built with the same
// toolchain — nor by side-loading a newer libstdc++.
//
// WHAT THIS DOES NOT DO: verify signatures. It reads what a manifest asserts;
// it does not check that the assertion is authentic or that the bytes are
// unmodified. Results from this path are reported with validation state
// UNVERIFIED and must never be presented as verified provenance. The disclosure
// verdict itself is unaffected — it comes from the same assertions either way.
//
// Structure being parsed (per C2PA / ISO 19566-5 JUMBF):
//
//   c2pa                                   <- store superbox
//     <manifest-label>                     <- one per manifest
//       c2pa.assertions
//         c2pa.actions[.v2]  -> cbor       <- digitalSourceType lives here
//         c2pa.hash.data     -> cbor
//       c2pa.claim           -> cbor       <- claim_generator_info
//       c2pa.signature       -> cbor       <- not inspected

const { decode } = require('./cbor');

// ── Container extraction ─────────────────────────────────────────────────────

// PNG: a single `caBX` chunk holds the whole JUMBF box.
function fromPng(buf) {
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    if (type === 'caBX') return buf.subarray(off + 8, off + 8 + len);
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return null;
}

// JPEG: APP11 segments, each prefixed `JP` + box instance (2) + packet
// sequence (4). A manifest larger than ~64KB is split across several segments
// and reassembled in sequence order.
//
// Every segment repeats the box's LBox+TBox header, not only the first. They
// must be dropped from continuation packets or the reassembled stream carries
// 8 spurious bytes per extra segment, and the JUMBF walk then reads garbage
// lengths and finds nothing. Verified against a two-segment manifest whose
// LBox declares 126,523 bytes: skipping the repeats reproduces that exactly,
// while keeping them yields 126,531.
//
// Single-segment files parse either way, so this only shows up on manifests
// large enough to split — which is most real ones.
function fromJpeg(buf) {
  let p = 2;
  const segs = [];
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xFF) { p++; continue; }
    const marker = buf[p + 1];
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { p += 2; continue; }
    if (marker === 0xDA) break;                       // start of scan: no more metadata
    if (p + 4 > buf.length) break;
    const len = buf.readUInt16BE(p + 2);
    if (len < 2) break;
    if (marker === 0xEB) {                            // APP11
      const s = buf.subarray(p + 4, p + 2 + len);
      if (s.length > 8 && s.subarray(0, 2).toString('latin1') === 'JP') {
        segs.push({ inst: s.readUInt16BE(2), seq: s.readUInt32BE(4), data: s.subarray(8) });
      }
    }
    p += 2 + len;
  }
  if (!segs.length) return null;
  const inst = segs[0].inst;                          // one box instance per manifest store
  const ordered = segs.filter((s) => s.inst === inst).sort((a, b) => a.seq - b.seq);
  // Keep LBox+TBox from the first packet only; strip the repeat from the rest.
  const parts = ordered.map((s, i) => (i === 0 ? s.data : s.data.subarray(8)));
  const jumbf = Buffer.concat(parts);

  // The first packet's LBox declares the whole box length. If reassembly does
  // not reproduce it, something about the segmentation is not as assumed —
  // better to report no manifest than to hand a corrupt buffer to the walker.
  if (jumbf.length >= 4) {
    const declared = jumbf.readUInt32BE(0);
    if (declared > 0 && declared !== jumbf.length) return null;
  }
  return jumbf;
}

// WebP: RIFF container, C2PA lives in a chunk named `C2PA`.
function fromWebp(buf) {
  let off = 12;                                       // RIFF____WEBP
  while (off + 8 <= buf.length) {
    const type = buf.subarray(off, off + 4).toString('latin1');
    const len = buf.readUInt32LE(off + 4);
    if (type === 'C2PA') return buf.subarray(off + 8, off + 8 + len);
    off += 8 + len + (len % 2);                       // chunks are even-padded
  }
  return null;
}

function extractJumbf(buf) {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return fromPng(buf);
  if (buf[0] === 0xFF && buf[1] === 0xD8) return fromJpeg(buf);
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF'
      && buf.subarray(8, 12).toString('latin1') === 'WEBP') return fromWebp(buf);
  return null;
}

// ── JUMBF ────────────────────────────────────────────────────────────────────

// Description box: 16-byte type UUID, 1 byte of toggles, then an optional
// null-terminated label when bit 1 is set.
function descriptionLabel(b) {
  if (b.length < 17) return null;
  if (!(b[16] & 0x02)) return null;
  const end = b.indexOf(0, 17);
  return end < 0 ? null : b.subarray(17, end).toString('utf8');
}

// Depth-first walk collecting every `cbor` payload with the label path that
// leads to it. Guards against malformed lengths rather than trusting the file.
function collectCbor(b, path, out, depth = 0) {
  if (depth > 16) return;
  let p = 0;
  while (p + 8 <= b.length) {
    const len = b.readUInt32BE(p);
    const type = b.subarray(p + 4, p + 8).toString('latin1');
    if (len < 8 || p + len > b.length) break;
    const payload = b.subarray(p + 8, p + len);
    if (type === 'jumb') {
      let label = null;
      if (payload.length >= 8) {
        const dlen = payload.readUInt32BE(0);
        if (payload.subarray(4, 8).toString('latin1') === 'jumd' && dlen >= 8 && dlen <= payload.length) {
          label = descriptionLabel(payload.subarray(8, dlen));
        }
      }
      collectCbor(payload, label ? path.concat(label) : path, out, depth + 1);
    } else if (type === 'cbor') {
      out.push({ path: path.slice(), data: payload });
    }
    p += len;
  }
}

// ── Store assembly ───────────────────────────────────────────────────────────

/**
 * Build a manifest store shaped like the one c2pa-rs emits, so classify() and
 * validationSummary() consume it without knowing which reader produced it.
 *
 * @param {Buffer} buf raw asset bytes
 * @returns {object|null} manifest store, or null when the asset carries none
 */
function readManifestStore(buf) {
  const jumbf = extractJumbf(buf);
  if (!jumbf) return null;

  const boxes = [];
  collectCbor(jumbf, [], boxes);
  if (!boxes.length) return null;

  const manifests = {};
  let active = null;

  for (const box of boxes) {
    // path is [store, manifestLabel, ...rest]; anything shallower is not ours.
    if (box.path.length < 2) continue;
    const manifestLabel = box.path[1];
    const leaf = box.path[box.path.length - 1];

    let decoded;
    try { decoded = decode(box.data); } catch (_) { continue; }

    const m = manifests[manifestLabel] ??= { label: manifestLabel, assertions: [] };

    if (leaf === 'c2pa.claim') {
      m.claim_generator = decoded.claim_generator ?? null;
      m.claim_generator_info = decoded.claim_generator_info ?? null;
      // The claim sits directly under the manifest, so it identifies the one
      // that is active. With several present the last wins, matching how the
      // store lists the most recently added manifest as active.
      active = manifestLabel;
    } else if (leaf !== 'c2pa.signature') {
      m.assertions.push({ label: leaf, data: decoded });
    }
  }

  const labels = Object.keys(manifests);
  if (!labels.length) return null;

  return {
    active_manifest: active ?? labels[labels.length - 1],
    manifests,
    // Signatures are not checked on this path. Stated explicitly rather than
    // omitted, so nothing downstream can mistake silence for success.
    validation_state: 'UNVERIFIED',
    validation_results: { activeManifest: { success: [], informational: [], failure: [] } },
  };
}

module.exports = { readManifestStore, extractJumbf };
