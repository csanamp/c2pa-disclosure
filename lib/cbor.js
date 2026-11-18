'use strict';

// Minimal CBOR decoder (RFC 8949), decode-only.
//
// Deliberately dependency-free. The obvious choice, `cbor-x`, ships an optional
// native accelerator (`cbor-extract`) — and native code is precisely what the
// pure-JS reader exists to avoid on hosts too old to load it. A decoder for the
// subset C2PA actually uses is small enough to own outright, and removes any
// possibility of a platform-specific failure in the fallback path.
//
// Supports major types 0–7: integers, byte and text strings (definite and
// indefinite length), arrays, maps, tags, and simple values including
// half/single/double floats. Not supported, because C2PA does not use them:
// bignum semantics beyond passing the tagged value through.

class CborError extends Error {}

function decodeFirst(buf) {
  const state = { buf, pos: 0 };
  const value = readItem(state, 0);
  return { value, bytesRead: state.pos };
}

function decode(buf) {
  return decodeFirst(buf).value;
}

function need(s, n) {
  if (s.pos + n > s.buf.length) throw new CborError('unexpected end of CBOR input');
}

// Reads the argument that follows an initial byte's additional-information
// field. Returns null for the indefinite-length marker (31).
function readArgument(s, ai) {
  if (ai < 24) return ai;
  switch (ai) {
    case 24: need(s, 1); return s.buf[s.pos++];
    case 25: need(s, 2); { const v = s.buf.readUInt16BE(s.pos); s.pos += 2; return v; }
    case 26: need(s, 4); { const v = s.buf.readUInt32BE(s.pos); s.pos += 4; return v; }
    case 27: {
      need(s, 8);
      const v = s.buf.readBigUInt64BE(s.pos); s.pos += 8;
      // Stay with Number where it is lossless; C2PA timestamps and sizes are
      // well inside that range.
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    case 31: return null;                                  // indefinite length
    default: throw new CborError(`reserved additional information ${ai}`);
  }
}

function readFloat16(s) {
  need(s, 2);
  const half = s.buf.readUInt16BE(s.pos); s.pos += 2;
  const exp = (half >> 10) & 0x1f;
  const frac = half & 0x3ff;
  const sign = (half & 0x8000) ? -1 : 1;
  if (exp === 0) return sign * frac * 2 ** -24;
  if (exp === 0x1f) return frac ? NaN : sign * Infinity;
  return sign * (frac + 1024) * 2 ** (exp - 25);
}

function readItem(s, depth) {
  if (depth > 64) throw new CborError('CBOR nesting too deep');
  need(s, 1);
  const initial = s.buf[s.pos++];
  const major = initial >> 5;
  const ai = initial & 0x1f;

  switch (major) {
    case 0: return readArgument(s, ai);                    // unsigned integer
    case 1: {                                              // negative integer
      const n = readArgument(s, ai);
      return typeof n === 'bigint' ? -1n - n : -1 - n;
    }
    case 2: case 3: {                                      // byte / text string
      const len = readArgument(s, ai);
      if (len === null) {                                  // indefinite: chunks until break
        const parts = [];
        for (;;) {
          need(s, 1);
          if (s.buf[s.pos] === 0xff) { s.pos++; break; }
          const chunk = readItem(s, depth + 1);
          parts.push(major === 3 ? Buffer.from(chunk, 'utf8') : chunk);
        }
        const joined = Buffer.concat(parts);
        return major === 3 ? joined.toString('utf8') : joined;
      }
      need(s, len);
      const slice = s.buf.subarray(s.pos, s.pos + len); s.pos += len;
      return major === 3 ? slice.toString('utf8') : Buffer.from(slice);
    }
    case 4: {                                              // array
      const len = readArgument(s, ai);
      const out = [];
      if (len === null) {
        for (;;) { need(s, 1); if (s.buf[s.pos] === 0xff) { s.pos++; break; } out.push(readItem(s, depth + 1)); }
      } else {
        for (let i = 0; i < len; i++) out.push(readItem(s, depth + 1));
      }
      return out;
    }
    case 5: {                                              // map
      const len = readArgument(s, ai);
      const out = {};
      const put = () => {
        const k = readItem(s, depth + 1);
        const v = readItem(s, depth + 1);
        // Non-string keys are stringified: C2PA maps are string-keyed, and a
        // plain object keeps the shape callers already expect.
        out[typeof k === 'string' ? k : String(k)] = v;
      };
      if (len === null) {
        for (;;) { need(s, 1); if (s.buf[s.pos] === 0xff) { s.pos++; break; } put(); }
      } else {
        for (let i = 0; i < len; i++) put();
      }
      return out;
    }
    case 6: {                                              // tagged value
      readArgument(s, ai);                                 // tag number, unused
      return readItem(s, depth + 1);                       // decode the content
    }
    case 7: {                                              // simple values / floats
      switch (ai) {
        case 20: return false;
        case 21: return true;
        case 22: return null;
        case 23: return undefined;
        case 25: return readFloat16(s);
        case 26: { need(s, 4); const v = s.buf.readFloatBE(s.pos); s.pos += 4; return v; }
        case 27: { need(s, 8); const v = s.buf.readDoubleBE(s.pos); s.pos += 8; return v; }
        case 31: throw new CborError('unexpected break');
        default: return readArgument(s, ai);               // other simple values
      }
    }
    default: throw new CborError(`unknown CBOR major type ${major}`);
  }
}

module.exports = { decode, decodeFirst, CborError };
