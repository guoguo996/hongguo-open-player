// SPDX-License-Identifier: GPL-3.0-only
// 视频评论服务离线单测：假传输层，不访问网络。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchVideoComments, fetchSeriesComments, fetchSeriesCommentReplies, buildCommentBody, mapComment, parseCommentJson,
} = require('../../src/server/native/video-comments');

const VID = '7673382597912710168';
const SID = '7673380933331864601';
const ok = data => ({ status: 200, data: typeof data === 'string' ? data : JSON.stringify(data) });

function commentRow({ id = '7674995954382422808', text = '好看', status = 1, nick = '果友', digg = 5, reply = 2, ts = 1786710830 } = {}) {
  return {
    data_type: 4,
    comment: {
      comment_id: id,
      common: { status, create_timestamp: ts, content: { text }, user_info: { base_info: { user_name: nick, user_avatar: 'http://img/a.jpg' } } },
      stat: { digg_count: digg, reply_count: reply },
    },
  };
}

test('buildCommentBody 使用评论通道 cs=4/sc=18/ct=4 且 need_count', () => {
  const body = buildCommentBody(VID, SID, 'cur');
  assert.equal(body.comment_source, 4);
  assert.equal(body.server_channel, 18);
  assert.equal(body.comment_type, 4);
  assert.equal(body.group_type, 30);
  assert.equal(body.sort, 1);
  assert.equal(body.need_count, true);
  assert.equal(body.group_id, VID);
  assert.equal(body.cursor, 'cur');
  assert.equal(body.business_param.book_id, SID);
});

test('parseCommentJson 保留 19 位 comment_id 为字符串', () => {
  const parsed = parseCommentJson('{"comment_id":7674995954382422808,"stat":{"digg_count":5}}');
  assert.equal(parsed.comment_id, '7674995954382422808');
  assert.equal(parsed.stat.digg_count, 5);
});

test('mapComment 取 common.content.text 与用户/统计字段，过滤非正常状态', () => {
  const mapped = mapComment(commentRow({ text: '狠狠期待了', nick: '舟渡晚川', digg: 106, reply: 1 }));
  assert.equal(mapped.text, '狠狠期待了');
  assert.equal(mapped.user_name, '舟渡晚川');
  assert.equal(mapped.digg_count, 106);
  assert.equal(mapped.reply_count, 1);
  assert.equal(mapped.comment_id, '7674995954382422808');
  assert.equal(mapped.created_at, 1786710830000);
  assert.equal(mapComment(commentRow({ status: 0 })), null); // 非正常状态过滤
  assert.equal(mapComment(commentRow({ text: '' })), null); // 空文本过滤
  assert.equal(mapComment(null), null);
});

test('fetchVideoComments 解析列表/总数/分页 cursor 取自 common_list_info', async () => {
  let captured = null;
  const transport = async (url, body, config) => {
    captured = { url, body: JSON.parse(body), headers: config.headers };
    return ok({
      code: 0,
      data: {
        data_list: [commentRow({ id: '1111111111111111111', text: '第一条' }), commentRow({ id: '2222222222222222222', text: '第二条' })],
        common_list_info: { total: 5784, has_more: true, cursor: '{"session_id":"s","offset":20}' },
      },
    });
  };
  const result = await fetchVideoComments({ seriesId: SID, vid: VID, transport, device: { deviceId: '7398123456789012345', installId: '7398123456789012346' } });
  assert.equal(result.success, true);
  assert.equal(result.items.length, 2);
  assert.equal(result.total, 5784);
  assert.equal(result.has_more, true);
  assert.equal(result.cursor, '{"session_id":"s","offset":20}');
  assert.equal(result.items[0].comment_id, '1111111111111111111');
  assert.equal(captured.headers['Comment-Source'], '4');
  assert.equal(captured.headers['Server-Channel'], '18');
  assert.equal(captured.body.comment_type, 4);
  assert.ok(captured.url.includes(`/novel/commentapi/comment/list/${VID}/v1/`));
});

test('fetchVideoComments 回传 cursor 翻页', async () => {
  const transport = async (_url, body) => {
    const parsed = JSON.parse(body);
    assert.equal(parsed.cursor, '{"session_id":"s","offset":20}');
    return ok({ code: 0, data: { data_list: [commentRow({ text: '第二页' })], common_list_info: { total: 5784, has_more: false, cursor: '' } } });
  };
  const result = await fetchVideoComments({ seriesId: SID, vid: VID, cursor: '{"session_id":"s","offset":20}', transport, device: { deviceId: '7398123456789012345', installId: '7398123456789012346' } });
  assert.equal(result.success, true);
  assert.equal(result.has_more, false);
  assert.equal(result.items[0].text, '第二页');
});

test('fetchSeriesComments 使用剧评通道 cs=601/sc=0/ct=2/gt=4（lf 域）且 group_id=seriesId', async () => {
  let captured = null;
  const transport = async (url, body, config) => {
    captured = { url, body: JSON.parse(body), headers: config.headers };
    return ok({
      code: 0,
      data: {
        data_list: [commentRow({ id: '3333333333333333333', text: '整季好看' }), commentRow({ id: '4444444444444444444', text: '演技在线' })],
        common_list_info: { total: 509, has_more: true, cursor: '20' },
      },
    });
  };
  const result = await fetchSeriesComments({ seriesId: SID, cache: false, transport, device: { deviceId: '7398123456789012345', installId: '7398123456789012346' } });
  assert.equal(result.success, true);
  assert.equal(result.items.length, 2);
  assert.equal(result.total, 509);
  assert.equal(result.has_more, true);
  assert.equal(result.cursor, '20');
  assert.equal(result.items[0].text, '整季好看');
  assert.equal(captured.headers['Comment-Source'], '601');
  assert.equal(captured.headers['Server-Channel'], '0');
  assert.equal(captured.body.comment_source, 601);
  assert.equal(captured.body.server_channel, 0);
  assert.equal(captured.body.comment_type, 2);
  assert.equal(captured.body.group_type, 4);
  assert.equal(captured.body.group_id, SID);
  assert.equal(captured.body.business_param.book_id, SID);
  assert.ok(captured.url.includes('api5-normal-lf.fqnovel.com'));
  assert.ok(captured.url.includes(`/novel/commentapi/comment/list/${SID}/v1/`));
});

test('fetchSeriesComments 主通道灰度拒绝(103001)时自动切换候选通道', async () => {
  const urls = [];
  const transport = async (url) => {
    urls.push(url);
    if (urls.length === 1) return ok({ code: 103001, data: null });
    return ok({ code: 0, data: { data_list: [commentRow({ text: '备通道剧评' })], common_list_info: { total: 564, has_more: false, cursor: '' } } });
  };
  const result = await fetchSeriesComments({ seriesId: SID, cache: false, transport, device: { deviceId: '7398123456789012345', installId: '7398123456789012346' } });
  assert.equal(urls.length, 2);
  assert.ok(urls[0].includes('api5-normal-lf.fqnovel.com'));
  assert.ok(urls[1].includes('api5-normal-hl.fqnovel.com'));
  assert.equal(result.success, true);
  assert.equal(result.total, 564);
  assert.equal(result.items[0].text, '备通道剧评');
});

test('fetchSeriesComments 全部候选灰度拒绝时给友好 notice', async () => {
  const transport = async () => ok({ code: 103001, data: null });
  const result = await fetchSeriesComments({ seriesId: SID, cache: false, transport, device: { deviceId: '7398123456789012345', installId: '7398123456789012346' } });
  assert.equal(result.success, false);
  assert.ok(result.notice.includes('103001'));
});

test('fetchSeriesComments 成功结果进缓存且失败时回退最近一次成功内容', async () => {
  const CACHE_SID = '779988777666555444';
  let failing = false;
  const transport = async () => {
    if (failing) return ok({ code: 103001, data: null });
    return ok({ code: 0, data: { data_list: [commentRow({ text: '缓存样本剧评' })], common_list_info: { total: 7, has_more: false, cursor: '' } } });
  };
  const device = { deviceId: '7398123456789012345', installId: '7398123456789012346' };
  const good = await fetchSeriesComments({ seriesId: CACHE_SID, transport, device });
  assert.equal(good.success, true);
  // TTL 内重复请求直接命中缓存，不再打上游
  let called = false;
  const counting = async () => { called = true; return ok({ code: 0, data: { data_list: [], common_list_info: {} } }); };
  const hit = await fetchSeriesComments({ seriesId: CACHE_SID, transport: counting, device });
  assert.equal(called, false);
  assert.equal(hit.items[0].text, '缓存样本剧评');
  // 上游进入频控窗口（103001）时回退缓存内容
  failing = true;
  const stale = await fetchSeriesComments({ seriesId: CACHE_SID, transport, device, fresh: true });
  assert.equal(stale.success, true);
  assert.equal(stale.items[0].text, '缓存样本剧评');
  assert.ok(stale.notice.includes('103001'));
  // 翻页请求不走缓存
  const page2 = await fetchSeriesComments({ seriesId: CACHE_SID, cursor: 'x', transport, device });
  assert.equal(page2.success, false);
});

test('fetchSeriesCommentReplies 有数据通道时返回回复列表', async () => {
  let captured = null;
  const transport = async (url, body, config) => {
    captured = { url, body: JSON.parse(body), headers: config.headers };
    return ok({
      code: 0,
      data: {
        reply_list: [{ reply_id: '7690999876543210123', common: { content: { text: '楼主说得对' }, create_timestamp: 1786710830, user_info: { base_info: { user_name: '追更侠' } } }, stat: { digg_count: 3 } }],
        comment_list_info: { total: 3, has_more: true, cursor: '5' },
      },
    });
  };
  const result = await fetchSeriesCommentReplies({
    seriesId: SID, commentId: '7690991828636173118', transport,
    device: { deviceId: '7398123456789012345', installId: '7398123456789012346' },
  });
  assert.equal(result.success, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].text, '楼主说得对');
  assert.equal(result.items[0].user_name, '追更侠');
  assert.equal(result.total, 3);
  assert.equal(result.has_more, true);
  assert.equal(result.cursor, '5');
  assert.equal(captured.body.comment_id, '7690991828636173118');
  assert.equal(captured.body.group_id, SID);
  assert.equal(captured.body.business_param.book_id, SID);
  assert.ok(captured.url.includes('/novel/commentapi/reply/list/7690991828636173118/v1/'));
});

test('fetchSeriesCommentReplies 无效参数给友好提示', async () => {
  const transport = async () => ok({ code: 0, data: { reply_list: [], comment_list_info: {} } });
  const result = await fetchSeriesCommentReplies({ seriesId: 'bad', commentId: '12', transport });
  assert.equal(result.success, false);
  assert.ok(result.notice.includes('红果来源'));
});

test('fetchSeriesComments 回传 cursor 翻页且非法 seriesId 转中文 notice', async () => {
  const transport = async (_url, body) => {
    assert.equal(JSON.parse(body).cursor, '20');
    return ok({ code: 0, data: { data_list: [commentRow({ text: '第二页剧评' })], common_list_info: { total: 509, has_more: false, cursor: '' } } });
  };
  const result = await fetchSeriesComments({ seriesId: SID, cursor: '20', transport, device: { deviceId: '7398123456789012345', installId: '7398123456789012346' } });
  assert.equal(result.success, true);
  assert.equal(result.has_more, false);
  assert.equal(result.items[0].text, '第二页剧评');
  const bad = await fetchSeriesComments({ seriesId: 'abc' });
  assert.equal(bad.success, false);
  assert.ok(bad.notice.includes('剧评'));
});

test('fetchVideoComments 非法 ID 与业务拒绝转中文 notice', async () => {
  const bad = await fetchVideoComments({ seriesId: 'abc', vid: VID });
  assert.equal(bad.success, false);
  assert.ok(bad.notice.includes('红果'));
  const rejected = await fetchVideoComments({
    seriesId: SID, vid: VID,
    transport: async () => ok({ code: 103001, message: 'param error' }),
    device: { deviceId: '7398123456789012345', installId: '7398123456789012346' },
  });
  assert.equal(rejected.success, false);
  assert.ok(rejected.notice.includes('103001'));
});