'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { decode, decodeFirst, CborError } = require('../lib/cbor');

const h = (hex) => Buffer.from(hex.replace(/\s+/g, ''), 'hex');

// Vectors from RFC 8949 appendix A. The decoder is hand-written specifically to
// avoid a native dependency in the fallback path, so it is checked against the
// specification rather than only against the files that happen to be to hand.
test('RFC 8949 integers', () => {
  assert.equal(decode(h('00')), 0);
  assert.equal(decode(h('01')), 1);
  assert.equal(decode(h('17')), 23);
  assert.equal(decode(h('1818')), 24);
  assert.equal(decode(h('1903e8')), 1000);
  assert.equal(decode(h('1a000f4240')), 1000000);
  assert.equal(decode(h('20')), -1);
  assert.equal(decode(h('3903e7')), -1000);
});

test('RFC 8949 large integers stay exact', () => {
  assert.equal(decode(h('1b000000e8d4a51000')), 1000000000000);
  // Beyond Number.MAX_SAFE_INTEGER the value must not be silently rounded.
  assert.equal(decode(h('1bffffffffffffffff')), 18446744073709551615n);
});

test('RFC 8949 floats', () => {
  assert.equal(decode(h('f90000')), 0);
  assert.equal(decode(h('f93c00')), 1);
  assert.equal(decode(h('f93e00')), 1.5);
  assert.equal(decode(h('fa47c35000')), 100000);
  assert.equal(decode(h('fb3ff199999999999a')), 1.1);
  assert.equal(decode(h('f97c00')), Infinity);
  assert.ok(Number.isNaN(decode(h('f97e00'))));
});

test('RFC 8949 simple values', () => {
  assert.equal(decode(h('f4')), false);
  assert.equal(decode(h('f5')), true);
  assert.equal(decode(h('f6')), null);
  assert.equal(decode(h('f7')), undefined);
});

test('RFC 8949 strings', () => {
  assert.equal(decode(h('60')), '');
  assert.equal(decode(h('6161')), 'a');
  assert.equal(decode(h('6449455446')), 'IETF');
  assert.deepEqual(decode(h('4401020304')), Buffer.from([1, 2, 3, 4]));
  // UTF-8 beyond ASCII
  assert.equal(decode(h('62c3bc')), 'ü');
});

test('RFC 8949 arrays and maps', () => {
  assert.deepEqual(decode(h('80')), []);
  assert.deepEqual(decode(h('83010203')), [1, 2, 3]);
  assert.deepEqual(decode(h('a0')), {});
  assert.deepEqual(decode(h('a201020304')), { 1: 2, 3: 4 });
  assert.deepEqual(decode(h('a26161016162820203')), { a: 1, b: [2, 3] });
  assert.deepEqual(decode(h('826161a161626163')), ['a', { b: 'c' }]);
});

test('indefinite-length items terminate on break', () => {
  assert.deepEqual(decode(h('9fff')), []);
  assert.deepEqual(decode(h('9f018202039f0405ffff')), [1, [2, 3], [4, 5]]);
  assert.deepEqual(decode(h('bf61610161629f0203ffff')), { a: 1, b: [2, 3] });
  assert.equal(decode(h('7f657374726561646d696e67ff')), 'streaming');
});

// C2PA timestamps arrive as tag 0 (date-time string). The content is passed
// through as the original string rather than converted to a Date, which keeps
// sub-millisecond precision that a Date round-trip would discard.
test('tags decode to their content', () => {
  assert.equal(decode(h('c074323031332d30332d32315432303a30343a30305a')), '2013-03-21T20:04:00Z');
  assert.equal(decode(h('c11a514b67b0')), 1363896240);
});

test('decodeFirst reports how many bytes were consumed', () => {
  const { value, bytesRead } = decodeFirst(h('83010203ffffff'));
  assert.deepEqual(value, [1, 2, 3]);
  assert.equal(bytesRead, 4);
});

test('truncated input throws rather than returning junk', () => {
  assert.throws(() => decode(h('1903')), CborError);
  assert.throws(() => decode(h('830102')), CborError);
  assert.throws(() => decode(h('')), CborError);
});

test('reserved additional information is rejected', () => {
  assert.throws(() => decode(h('1c')), CborError);
});

test('deeply nested input is refused rather than blowing the stack', () => {
  // 100 nested single-element arrays, past the depth guard.
  const deep = Buffer.concat([Buffer.alloc(100, 0x81), Buffer.from([0x00])]);
  assert.throws(() => decode(deep), CborError);
});
