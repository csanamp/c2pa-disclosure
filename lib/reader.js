'use strict';

// A CommonJS reader over the C2PA native addon.
//
// `@contentauth/c2pa-node` is an ESM-only package, so the obvious way in is
// `await import('@contentauth/c2pa-node')`. That does not work under the
// Amplience processing-job runner, which executes the script with
// `vm.runInNewContext`. A vm context has no module loader attached, so any
// dynamic import fails with:
//
//   A dynamic import callback was not specified.
//
// The addon underneath is an ordinary CommonJS native module, and `require` is
// available inside the sandbox, so this loads `dist/index.node` directly and
// reimplements the handful of methods the tool actually uses. The upstream
// wrapper does the same thing internally — `binary.js` calls
// `createRequire(import.meta.url)` and then requires the same file — so this
// bypasses the ESM shell without bypassing anything meaningful.
//
// Doing so also skips upstream's `assetSize.js`, which is no loss: its
// `FileAsset` path is broken (`import * as fs from "fs-extra"` leaves
// `fs.stat` undefined), and the size guard is reimplemented below.
//
// Falls back to the ESM package if the addon cannot be located, so a future
// upstream layout change degrades to the documented API rather than breaking.

const path = require('path');
const { readManifestStore } = require('./manifest');

// Matches upstream's limit. Buffers are already resident by the time this runs,
// so this bounds what is handed to the native reader, not peak memory.
const MAX_SIZE_IN_BYTES = 10 * 10 ** 9;

let neon = null;
let loadError = null;

function loadNeon() {
  if (neon || loadError) return neon;
  try {
    // C2PA_LIBRARY_PATH is honoured by upstream too; keep it working.
    const override = process.env.C2PA_LIBRARY_PATH;
    if (override) { neon = require(override); return neon; }
    const pkgJson = require.resolve('@contentauth/c2pa-node/package.json');
    neon = require(path.join(path.dirname(pkgJson), 'dist', 'index.node'));
    return neon;
  } catch (e) {
    loadError = e;
    return null;
  }
}

class NativeReader {
  constructor(handle) { this.handle = handle; }
  json() { return JSON.parse(loadNeon().readerJson.call(this.handle)); }
  isEmbedded() { return loadNeon().readerIsEmbedded.call(this.handle); }
  remoteUrl() { return loadNeon().readerRemoteUrl.call(this.handle); }
  getActive() {
    const store = this.json();
    return store.active_manifest ? store.manifests?.[store.active_manifest] : undefined;
  }

  // Mirrors Reader.fromAsset: resolves to null when the asset carries no
  // manifest at all, rather than throwing.
  static async fromAsset(asset, settings) {
    const n = loadNeon();
    if (!n) throw loadError;
    if (asset && asset.buffer && asset.buffer.length > MAX_SIZE_IN_BYTES) {
      throw new Error(`asset is ${asset.buffer.length} bytes, over the ${MAX_SIZE_IN_BYTES} limit`);
    }
    const settingsStr = settings
      ? (typeof settings === 'string' ? settings : JSON.stringify(settings))
      : undefined;
    const handle = await n.readerFromAsset(asset, settingsStr);
    return handle ? new NativeReader(handle) : null;
  }
}

// Pure-JS reader. Reads what a manifest asserts without verifying signatures,
// for hosts whose C runtime is too old for the native addon. Same interface as
// NativeReader so callers cannot tell them apart by shape — only by the
// validation state, which is UNVERIFIED here and must stay visible.
class JsReader {
  constructor(store) { this.store = store; }
  json() { return this.store; }
  isEmbedded() { return true; }        // only embedded manifests are parsed
  remoteUrl() { return null; }         // remote manifest fetch is not supported
  getActive() {
    return this.store.active_manifest
      ? this.store.manifests?.[this.store.active_manifest]
      : undefined;
  }

  static async fromAsset(asset) {
    const buf = asset && asset.buffer;
    if (!buf) throw new Error('the pure-JS reader requires { buffer, mimeType }');
    if (buf.length > MAX_SIZE_IN_BYTES) {
      throw new Error(`asset is ${buf.length} bytes, over the ${MAX_SIZE_IN_BYTES} limit`);
    }
    const store = readManifestStore(buf);
    return store ? new JsReader(store) : null;
  }
}

// Smallest valid PNG carrying no manifest. A working reader resolves null for
// it; a reader whose native library cannot load throws instead.
const PROBE_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478' +
  '9c6300010000050001' + '0d0a2db40000000049454e44ae426082', 'hex');

// Whether a load failure is the library itself being unusable, as opposed to
// the probe asset being rejected on its merits.
const LOAD_FAILURE = /dlopen|mach-o|invalid ELF|not a valid Win32|GLIBC|libstdc\+\+|dynamic import|cannot open shared object|symbol not found/i;

// A reader can construct successfully and still be unusable: the ESM package
// imports fine while the native library beneath it fails to dlopen, which
// surfaces only when an asset is read. Probing here means one clear message at
// startup instead of an identical error against every asset in the sweep.
async function usable(Reader) {
  try {
    await Reader.fromAsset({ buffer: PROBE_PNG, mimeType: 'image/png' });
    return { ok: true };
  } catch (e) {
    const msg = String(e && e.message);
    if (LOAD_FAILURE.test(msg)) return { ok: false, why: msg.slice(0, 140) };
    return { ok: true };            // rejected the probe asset, but the library works
  }
}

/**
 * Resolve a Reader implementation, strongest first:
 *
 *   1. the native addon, which validates signatures
 *   2. the ESM package, for non-sandboxed hosts where the addon is absent
 *   3. the pure-JS parser, which reads assertions but verifies nothing
 *
 * Each candidate is probed before being accepted, so a library that loads but
 * cannot run is skipped rather than failing later against every asset.
 *
 * Returns { Reader, verifies, why } so the caller can say plainly which one is
 * in use. A silent downgrade from verified to unverified provenance would be
 * the worst possible failure mode for this tool.
 */
async function getReader() {
  const reasons = [];

  if (loadNeon()) {
    const probe = await usable(NativeReader);
    if (probe.ok) return { Reader: NativeReader, verifies: true, why: 'native addon' };
    reasons.push(`native addon: ${probe.why}`);
  } else {
    reasons.push(`native addon: ${String(loadError?.message ?? 'not found').slice(0, 120)}`);
  }

  try {
    const mod = await import('@contentauth/c2pa-node');
    const probe = await usable(mod.Reader);
    if (probe.ok) return { Reader: mod.Reader, verifies: true, why: 'ESM package' };
    reasons.push(`ESM package: ${probe.why}`);
  } catch (e) {
    reasons.push(`ESM package: ${String(e && e.message).slice(0, 120)}`);
  }

  return { Reader: JsReader, verifies: false, why: reasons.join('; ') };
}

module.exports = { getReader, NativeReader, JsReader, MAX_SIZE_IN_BYTES };
