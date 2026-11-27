const { test } = require('node:test');
const assert = require('node:assert/strict');
const { VID_PATTERN, isValidVid } = require('../../src/server/native/vid-format');

test('isValidVid accepts legacy numeric vids', () => {
  assert.equal(isValidVid('7359215471096286751'), true);
  assert.equal(isValidVid('1234567890'), true);
  assert.equal(isValidVid(1234567890), true);
});

test('isValidVid accepts v1_ string vids used by new series (2026-11)', () => {
  assert.equal(isValidVid('v1_jVYv3CXvRYrApnPTvwai4Sb4eoY'), true);
  assert.equal(isValidVid('v1_YdTe3w9FULHyTrMURqgSRc7--aY'), true);
  assert.equal(isValidVid('v1_2Kq-8sq30DS602e0KxYxsi3RKjA'), true);
});

test('isValidVid rejects malformed or unsafe vids', () => {
  assert.equal(isValidVid(''), false);
  assert.equal(isValidVid(null), false);
  assert.equal(isValidVid(undefined), false);
  assert.equal(isValidVid('v1_'), false);
  assert.equal(isValidVid('v2_abc'), false);
  assert.equal(isValidVid('v1_abc/../../etc'), false);
  assert.equal(isValidVid('v1_abc def'), false);
  assert.equal(isValidVid('../../etc/passwd'), false);
  assert.equal(isValidVid('99999999999999999999999999999999999999999999999999999999'), false);
  // 字符集合法但超出 v1_ 长度上限
  assert.equal(isValidVid('v1_' + 'a'.repeat(65)), false);
});

test('VID_PATTERN stays anchored to the whole string', () => {
  assert.equal(VID_PATTERN.test('123\nok'), false);
  assert.equal(VID_PATTERN.test('abc123'), false);
});
