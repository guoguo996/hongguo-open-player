// SPDX-License-Identifier: GPL-3.0-only
// 发弹幕离线单测：假账号 + 假传输层，不访问网络、不真实发送。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { publishDanmaku, buildPublishBody, cleanText, md5Upper, ADD_PATH, MAX_SEND_LEN } = require('../../src/server/native/danmaku-publish');

const SERIES_ID = '7412345678901234567';
const VID = '7412345678901234568';
const DEVICE = { deviceId: '7398123456789012345', installId: '7398123456789012346' };
const NOW = () => 1_763_000_000_000;
const RANDOM = size => Buffer.alloc(size, 7);
const loggedInAccount = { loggedIn: () => true, _jar: { cookieString: () => 'sessionid=sess-abc; sid_guard=x' } };

function fakeTransport(payload, capture) {
  return async (url, body, config) => {
    if (capture) Object.assign(capture, { url, body, config });
    return { data: typeof payload === 'string' ? payload : JSON.stringify(payload) };
  };
}
const baseOptions = extra => ({
  seriesId: SERIES_ID, vid: VID, text: '好看', timeSec: 12.5, durationSec: 120,
  account: loggedInAccount, device: DEVICE, now: NOW, random: RANDOM,
  ...extra,
});

test('buildPublishBody 形状与列表 body 一致并补 content/offset_time', () => {
  const body = buildPublishBody({ vid: VID, seriesId: SERIES_ID, text: '测试', offsetMs: 12500, durationMs: 120000 });
  assert.equal(body.comment_source, 601);
  assert.equal(body.server_channel, 1000);
  assert.equal(body.group_id, VID);
  assert.equal(body.group_type, 30);
  assert.equal(body.comment_type, 20);
  assert.equal(body.aid, 8662);
  assert.deepEqual(body.content, { text: '测试' });
  assert.equal(body.offset_time, 12500);
  assert.deepEqual(body.business_param, { book_id: SERIES_ID, playlet_item_duration: 120000 });
  assert.equal(body.cursor, undefined);
  assert.equal(body.count, undefined);
  const fallback = buildPublishBody({ vid: VID, seriesId: SERIES_ID, text: 'x', offsetMs: 0 });
  assert.equal(fallback.business_param.playlet_item_duration, 3600000);
});

test('cleanText 清洗控制字符', () => {
  assert.equal(cleanText(' 你好\u0000世界\u2028 '), '你好 世界');
  assert.equal(cleanText('\u0001\u0002'), '');
});

test('参数校验：非法剧集号/空文本/超长/负时间点', async () => {
  const invalid = await publishDanmaku(baseOptions({ seriesId: 'abc' }));
  assert.equal(invalid.success, false);
  assert.equal(invalid.unverified, true);
  const empty = await publishDanmaku(baseOptions({ text: '   ' }));
  assert.ok(empty.notice.includes('不能为空'));
  const long = await publishDanmaku(baseOptions({ text: '字'.repeat(MAX_SEND_LEN + 1) }));
  assert.ok(long.notice.includes(String(MAX_SEND_LEN)));
  const negative = await publishDanmaku(baseOptions({ timeSec: -1 }));
  assert.ok(negative.notice.includes('时间点'));
});

test('未登录时返回 need_login，不发起请求', async () => {
  let called = false;
  const result = await publishDanmaku(baseOptions({
    account: { loggedIn: () => false, _jar: { cookieString: () => '' } },
    transport: async () => { called = true; return { data: '{}' }; },
  }));
  assert.equal(result.success, false);
  assert.equal(result.need_login, true);
  assert.equal(called, false);
});

test('发送成功：签名头齐全、X-SS-STUB=md5(body) 大写、携带登录 Cookie、offset 封顶', async () => {
  const capture = {};
  const result = await publishDanmaku(baseOptions({ transport: fakeTransport({ code: 0 }, capture) }));
  assert.equal(result.success, true);
  assert.equal(result.unverified, true);
  assert.ok(capture.url.includes(ADD_PATH));
  assert.ok(capture.url.includes(`device_id=${DEVICE.deviceId}`));
  const headers = capture.config.headers;
  assert.equal(headers['X-SS-STUB'], md5Upper(capture.body));
  assert.equal(headers.Cookie, 'sessionid=sess-abc; sid_guard=x');
  assert.ok(headers['X-Gorgon']);
  assert.ok(headers['X-Argus']);
  assert.ok(headers['X-Ladon']);
  assert.equal(headers['X-Khronos'], String(Math.floor(NOW() / 1000)));
  const body = JSON.parse(capture.body);
  assert.equal(body.offset_time, 12500);
  assert.deepEqual(body.content, { text: '好看' });

  // timeSec 超过本集时长时 offset 封顶到 durationMs
  const capped = {};
  await publishDanmaku(baseOptions({ timeSec: 999, transport: fakeTransport({ code: 0 }, capped) }));
  assert.equal(JSON.parse(capped.body).offset_time, 120000);
});

test('上游拒绝与非 JSON 响应转为中文 notice 且恒 unverified', async () => {
  const rejected = await publishDanmaku(baseOptions({ transport: fakeTransport({ code: 8, message: 'deny' }) }));
  assert.equal(rejected.success, false);
  assert.equal(rejected.unverified, true);
  assert.ok(rejected.notice.includes('推断'));
  const notJson = await publishDanmaku(baseOptions({ transport: fakeTransport('<html>blocked</html>') }));
  assert.equal(notJson.success, false);
  assert.ok(notJson.notice.includes('非 JSON'));
});

test('网络错误与 HTTP 错误转为中文 notice，不透传异常文本', async () => {
  const timeout = await publishDanmaku(baseOptions({
    transport: async () => { const error = new Error('timeout of 15000ms exceeded'); error.code = 'ECONNABORTED'; throw error; },
  }));
  assert.equal(timeout.success, false);
  assert.ok(timeout.notice.includes('超时'));
  const http = await publishDanmaku(baseOptions({
    transport: async () => { const error = new Error('Request failed with status code 403'); error.response = { status: 403 }; throw error; },
  }));
  assert.ok(http.notice.includes('HTTP 403'));
  const offline = await publishDanmaku(baseOptions({
    transport: async () => { throw new Error('getaddrinfo ENOTFOUND secret-host.example'); },
  }));
  assert.equal(offline.success, false);
  assert.ok(!offline.notice.includes('secret-host'));
});