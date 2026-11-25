// SPDX-License-Identifier: GPL-3.0-only
// 视频评论列表（只读）。与弹幕共用 comment/list 端点与签名族（danmaku-sign.js，73532），
// 区别只在业务参数成套切换：comment_source=4 / server_channel=18 / comment_type=4，
// 请求头 Comment-Source / Server-Channel 必须同步为 4 / 18（601/1000 是弹幕专用通道）。
// 参数与字段路径经本机实证（参考 N3urda/hongguoTV AppCommentPages.kt）。
'use strict';

const axios = require('axios');
const crypto = require('node:crypto');
const sign = require('./danmaku-sign');
const { resolveDeviceIdentity } = require('./danmaku');

const BASE_URL = 'https://api5-normal-sinfonlineb.fqnovel.com';
const COMMENT_PATH = vid => `/novel/commentapi/comment/list/${encodeURIComponent(vid)}/v1/`;
// 写接口：点赞走 do_action（action_type 8/9，object_type=2 评论/回复通用）。
// 回复列表走 reply/list。端点路由按 (comment_source, aid) 匹配 handler——
// 经实扫（2026-11-18，扫描 source 0..3000）短剧评论回复页 source=504 才有 handler
// 并能返回真实回复（与 reply_count 一致，分页正常）；参考实现的 501 是书评通道，在
// aid=8662 上返回「cannot found handler」。
// 写请求依据 naiyQAQ/fanqie-assistant 抓包实证：登录态 Cookie 必带，body 参与 X-Argus 哈希。
const DO_ACTION_PATH = '/novel/commentapi/comment/do_action/v1/';
const REPLY_LIST_PATH = commentId => `/novel/commentapi/reply/list/${encodeURIComponent(commentId)}/v1/`;
const REPLY_LIST_SOURCE = 504;
const USER_AGENT =
  'com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; ' +
  'Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)';

const PAGE_COUNT = 20;
const REQUEST_TIMEOUT = 15000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const str = value => (value === null || value === undefined ? '' : String(value)).trim();
const toMs = value => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return num < 1e12 ? Math.round(num * 1000) : Math.round(num);
};

// comment_id / user_id 等 19 位大整数先转字符串，避免 JSON.parse 丢精度。
function parseCommentJson(raw) {
  const guarded = String(raw).replace(/("(?:comment_id|user_id|id|reply_id|parent_id)"\s*:\s*)(\d{16,})/g, '$1"$2"');
  return JSON.parse(guarded);
}

function buildCommentBody(vid, seriesId, cursor = '') {
  return {
    comment_source: 4,
    server_channel: 18,
    group_id: vid,
    group_type: 30,
    comment_type: 4,
    sort: 1,
    need_count: true,
    count: PAGE_COUNT,
    cursor: typeof cursor === 'string' ? cursor : '',
    aid: 8662,
    compliance_status: 0,
    business_param: { book_id: seriesId, req_type: 0 },
  };
}

function mapComment(raw) {
  const comment = raw?.comment;
  if (!comment || typeof comment !== 'object') return null;
  const common = comment.common && typeof comment.common === 'object' ? comment.common : {};
  if (Number(common.status) !== 1) return null; // 仅展示正常状态的评论
  const content = common.content && typeof common.content === 'object' ? common.content : {};
  const baseInfo = common.user_info?.base_info || {};
  const stat = comment.stat && typeof comment.stat === 'object' ? comment.stat : {};
  const action = comment.user_action && typeof comment.user_action === 'object' ? comment.user_action : {};
  const text = str(content.text);
  if (!text) return null;
  return {
    comment_id: str(comment.comment_id),
    text,
    user_name: str(baseInfo.user_name) || '红果用户',
    user_avatar: str(baseInfo.user_avatar),
    digg_count: Number(stat.digg_count) || 0,
    reply_count: Number(stat.reply_count) || 0,
    liked: Boolean(action.user_digg),
    created_at: toMs(common.create_timestamp),
  };
}

/**
 * 拉取一页视频评论。
 * @returns {Promise<{success:boolean, items:Array, total:number, has_more:boolean, cursor:string, notice:string, error:string}>}
 */
async function fetchVideoComments(options = {}) {
  const base = { success: false, items: [], total: 0, has_more: false, cursor: '', notice: '', error: '' };
  const vid = str(options.vid);
  const seriesId = str(options.seriesId);
  if (!/^\d{6,30}$/.test(vid) || !/^\d{6,30}$/.test(seriesId)) {
    return { ...base, notice: '仅红果来源的剧集支持查看评论' };
  }
  const transport = options.transport || axios.post;
  const now = options.now || Date.now;
  const random = options.random || crypto.randomBytes;
  try {
    const stampMs = now();
    const stamp = Math.floor(stampMs / 1000);
    const nonce = random(sign.NONCE_BYTES);
    const { deviceId, installId } = options.device || await resolveDeviceIdentity();
    const rawQuery = sign.buildQuery({ stampMs, deviceId, installId });
    const url = `${BASE_URL}${COMMENT_PATH(vid)}?${rawQuery}`;
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'X-XS-From-Web': '0',
      'Sdk-Version': '2',
      'Content-Type': 'application/json; charset=utf-8',
      'Comment-Source': '4',
      'Server-Channel': '18',
      ...sign.signCommentHeaders({ rawQuery, stamp, nonce }),
    };
    const response = await transport(url, JSON.stringify(buildCommentBody(vid, seriesId, options.cursor)), {
      headers,
      timeout: REQUEST_TIMEOUT,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      maxRedirects: 0,
      responseType: 'text',
      maxContentLength: MAX_RESPONSE_BYTES,
    });
    const raw = typeof response?.data === 'string' ? response.data : JSON.stringify(response?.data ?? null);
    let payload;
    try { payload = parseCommentJson(raw); } catch (_) {
      return { ...base, notice: '评论接口返回了非 JSON 内容' };
    }
    const code = Number(payload?.code ?? payload?.Code ?? -1);
    if (code !== 0) return { ...base, notice: `评论接口拒绝请求（code=${code}）` };
    const data = payload?.data || {};
    const list = Array.isArray(data.data_list) ? data.data_list : [];
    const items = list.map(mapComment).filter(Boolean);
    const info = data.common_list_info && typeof data.common_list_info === 'object' ? data.common_list_info : {};
    const total = Number(info.total) || 0;
    const hasMore = Boolean(info.has_more);
    const cursor = typeof info.cursor === 'string' ? info.cursor : (info.cursor ? JSON.stringify(info.cursor) : '');
    return { success: true, items, total, has_more: hasMore, cursor, notice: items.length || total ? '' : '暂无评论', error: '' };
  } catch (error) {
    const notice = error?.code === 'ECONNABORTED' || error?.name === 'TimeoutError' || error?.code === 'ERR_CANCELED'
      ? '评论加载超时，请稍后重试'
      : '评论加载失败，请检查网络后重试';
    return { ...base, notice, error: notice };
  }
}

// 剧评（整季评论）通道：与分集评论完全不同的一组路由参数——group_id 直接用 seriesId。
// 经本机实扫矩阵（4 host × source × group_type）：
//   2026-11-23：仅 cs=1011/sc=0/ct=2/gt=2（sinfonlineb）返回真实剧评（total=509）；
//   2026-11-25：1011 通道被上游灰度关闭（code=103001），重扫后可用组合变为
//     cs=601/gt=4（api5-normal-lf，两次实测稳定 total=564）与
//     cs=601/gt=30（api5-normal-hl，灰度窗口飘忽、时通时断）。
// 条目结构与分集评论相同（{ comment: {...} } 包裹），mapComment 通用。
// 上游灰度随 host/组合漂移，故按候选顺序尝试，灰度拒绝（103001）时自动切换下一个。
const SERIES_COMMENT_SOURCE = 601;
const SERIES_CANDIDATES = [
  { host: 'api5-normal-lf.fqnovel.com', groupType: 4 },
  { host: 'api5-normal-hl.fqnovel.com', groupType: 30 },
];

// 剧评内存缓存（stale-while-error）：上游对剧评接口存在按设备的频控——短时间连续
// 请求会触发 code=103001 静默限流（N3urda #118 描述的同款机制，窗口数分钟）。
// 成功结果缓存 10 分钟，期内重复打开直接命中；限流/网络失败时回退最近一次成功
// 内容（无论多久前），避免把配额烧在重试上，也保证界面多数时候有内容。
const seriesCommentCache = new Map(); // seriesId -> { at, result }
const SERIES_CACHE_TTL = 10 * 60 * 1000;

/**
 * 拉取整季剧评（针对整部剧的评论，非单集）。
 * @param {object} [options] cursor/fresh/transport/device/now/random/cache
 * @returns {Promise<{success:boolean, items:Array, total:number, has_more:boolean, cursor:string, notice:string, error:string}>}
 */
async function fetchSeriesComments(options = {}) {
  const base = { success: false, items: [], total: 0, has_more: false, cursor: '', notice: '', error: '' };
  const seriesId = str(options.seriesId);
  if (!/^\d{6,30}$/.test(seriesId)) {
    return { ...base, notice: '仅红果来源的剧集支持查看剧评' };
  }
  const useCache = options.cache !== false && !(typeof options.cursor === 'string' && options.cursor);
  const now = options.now || Date.now;
  const cached = seriesCommentCache.get(seriesId);
  if (useCache && !options.fresh && cached && now() - cached.at < SERIES_CACHE_TTL) {
    return { ...cached.result, notice: cached.result.notice || '' };
  }
  const transport = options.transport || axios.post;
  const random = options.random || crypto.randomBytes;
  try {
    const { deviceId, installId } = options.device || await resolveDeviceIdentity();
    let payload = null;
    let lastCode = -1;
    for (const candidate of SERIES_CANDIDATES) {
      const stampMs = now();
      const stamp = Math.floor(stampMs / 1000);
      const nonce = random(sign.NONCE_BYTES);
      const rawQuery = sign.buildQuery({ stampMs, deviceId, installId });
      const url = `https://${candidate.host}${COMMENT_PATH(seriesId)}?${rawQuery}`;
      const headers = {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'X-XS-From-Web': '0',
        'Sdk-Version': '2',
        'Content-Type': 'application/json; charset=utf-8',
        'Comment-Source': String(SERIES_COMMENT_SOURCE),
        'Server-Channel': '0',
        ...sign.signCommentHeaders({ rawQuery, stamp, nonce }),
      };
      const body = {
        comment_source: SERIES_COMMENT_SOURCE,
        server_channel: 0,
        group_id: seriesId,
        group_type: candidate.groupType,
        comment_type: 2,
        sort: 1,
        need_count: true,
        count: PAGE_COUNT,
        cursor: typeof options.cursor === 'string' ? options.cursor : '',
        aid: 8662,
        compliance_status: 0,
        business_param: { book_id: seriesId, req_type: 0 },
      };
      const response = await transport(url, JSON.stringify(body), {
        headers,
        timeout: REQUEST_TIMEOUT,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        maxRedirects: 0,
        responseType: 'text',
        maxContentLength: MAX_RESPONSE_BYTES,
      });
      const raw = typeof response?.data === 'string' ? response.data : JSON.stringify(response?.data ?? null);
      try { payload = parseCommentJson(raw); } catch (_) {
        return staleOr(base, '剧评接口返回了非 JSON 内容');
      }
      lastCode = Number(payload?.code ?? payload?.Code ?? -1);
      if (lastCode === 0) break; // 当前候选通道可用，直接使用其结果
    }
    // 全部候选均被灰度拒绝（如 103001，多为频控窗口）时回退缓存
    if (!payload || lastCode !== 0) {
      return staleOr(base, `剧评服务暂时不可用（code=${lastCode}），请稍后再试`);
    }
    const data = payload?.data || {};
    const list = Array.isArray(data.data_list) ? data.data_list : [];
    const items = list.map(mapComment).filter(Boolean);
    const info = data.common_list_info && typeof data.common_list_info === 'object' ? data.common_list_info : {};
    const total = Number(info.total) || 0;
    const hasMore = Boolean(info.has_more);
    const cursor = typeof info.cursor === 'string' ? info.cursor : (info.cursor ? JSON.stringify(info.cursor) : '');
    const result = { success: true, items, total, has_more: hasMore, cursor, notice: items.length || total ? '' : '暂无剧评', error: '' };
    if (useCache && (items.length || total)) seriesCommentCache.set(seriesId, { at: now(), result });
    return result;
  } catch (error) {
    const notice = error?.code === 'ECONNABORTED' || error?.name === 'TimeoutError' || error?.code === 'ERR_CANCELED'
      ? '剧评加载超时，请稍后重试'
      : '剧评加载失败，请检查网络后重试';
    return staleOr({ ...base, error: notice }, notice);
  }

  // 失败时回退最近一次成功结果（无论多久之前）：多数时候保证界面有内容可看
  function staleOr(fallback, notice) {
    if (useCache && cached) {
      return { ...cached.result, notice: `${notice}；已为你展示最近获取的剧评`, error: '' };
    }
    return { ...fallback, notice };
  }
}

// ── 写操作（点赞 / 回复）：登录态 Cookie 必带，body 参与 X-Argus 哈希 ──────────

/**
 * 已签名的 commentapi 写请求。与列表共用签名族；区别：
 *   - body 必须传入 signCommentHeaders（X-Argus 字段 13 = sm3(body)）；
 *   - X-SS-STUB 填 body 的 MD5（TTNet 对带 body 的 POST 的标准校验）；
 *   - 携带账号登录态 Cookie（sessionid），缺了上游回 code=103006 未登录。
 */
async function postCommentWrite(path, body, { cookie, transport, now, random, device } = {}) {
  const transportFn = transport || axios.post;
  const stampMs = (now || Date.now)();
  const stamp = Math.floor(stampMs / 1000);
  const nonce = (random || crypto.randomBytes)(sign.NONCE_BYTES);
  const { deviceId, installId } = device || await resolveDeviceIdentity();
  const rawQuery = sign.buildQuery({ stampMs, deviceId, installId });
  const rawBody = JSON.stringify(body);
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    'X-XS-From-Web': '0',
    'Sdk-Version': '2',
    'Content-Type': 'application/json; charset=utf-8',
    'Comment-Source': '4',
    'Server-Channel': '18',
    ...sign.signCommentHeaders({ rawQuery, stamp, nonce, body: rawBody }),
    // signCommentHeaders 恒置空 X-SS-STUB，写请求需覆写为 body 的 MD5
    'X-SS-STUB': sign.md5(Buffer.from(rawBody, 'utf8')).toString('hex'),
    ...(cookie ? { Cookie: cookie } : {}),
  };
  const response = await transportFn(`${BASE_URL}${path}?${rawQuery}`, rawBody, {
    headers,
    timeout: REQUEST_TIMEOUT,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    maxRedirects: 0,
    responseType: 'text',
    maxContentLength: MAX_RESPONSE_BYTES,
  });
  const raw = typeof response?.data === 'string' ? response.data : JSON.stringify(response?.data ?? null);
  let payload;
  try { payload = parseCommentJson(raw); } catch (_) {
    throw Object.assign(new Error('评论接口返回了非 JSON 内容'), { businessCode: -1 });
  }
  const code = Number(payload?.code ?? payload?.Code ?? -1);
  if (code !== 0) {
    throw Object.assign(new Error(`评论接口拒绝请求（code=${code}）`), { businessCode: code });
  }
  return payload?.data || {};
}

function commentWriteGuard({ vid, seriesId, commentId, cookie }) {
  if (!/^\d{6,30}$/.test(str(vid)) || !/^\d{6,30}$/.test(str(seriesId))) return '仅红果来源的剧集支持评论互动';
  if (!/^\d{6,30}$/.test(str(commentId))) return '评论编号无效';
  if (!str(cookie)) return '请先扫码登录红果账号';
  return '';
}

/**
 * 评论点赞 / 取消点赞（object_type=2 评论与回复通用）。
 * @returns {Promise<{success:boolean, digg_count?:number, notice:string, error:string}>}
 */
async function likeVideoComment(options = {}) {
  const base = { success: false, notice: '', error: '' };
  const guard = commentWriteGuard(options);
  if (guard) return { ...base, notice: guard };
  const liked = Boolean(options.liked);
  try {
    await postCommentWrite(DO_ACTION_PATH, {
      action_type: liked ? 8 : 9,
      business_param: {},
      comment_type: 4,
      object_id: str(options.commentId),
      object_type: 2,
    }, { cookie: str(options.cookie), transport: options.transport, now: options.now, random: options.random, device: options.device });
    return { success: true, notice: liked ? '' : '已取消点赞', error: '' };
  } catch (error) {
    const business = Number(error?.businessCode);
    if (business === 103006) return { ...base, notice: '登录态已失效，请重新扫码登录' };
    const notice = error?.code === 'ECONNABORTED' || error?.name === 'TimeoutError'
      ? '点赞请求超时，请稍后重试'
      : '点赞失败，请稍后重试';
    return { ...base, notice, error: notice };
  }
}

/**
 * 某条评论下的回复列表（只读，匿名可调用）。
 * @returns {Promise<{success:boolean, items:Array, total:number, has_more:boolean, cursor:string, notice:string, error:string}>}
 */
async function fetchCommentReplies(options = {}) {
  const base = { success: false, items: [], total: 0, has_more: false, cursor: '', notice: '', error: '' };
  const vid = str(options.vid);
  const seriesId = str(options.seriesId);
  const commentId = str(options.commentId);
  const cursor = str(options.cursor);
  if (!/^\d{6,30}$/.test(vid) || !/^\d{6,30}$/.test(seriesId) || !/^\d{6,30}$/.test(commentId)) {
    return { ...base, notice: '仅红果来源的评论支持查看回复' };
  }
  const transport = options.transport || axios.post;
  const now = options.now || Date.now;
  const random = options.random || crypto.randomBytes;
  try {
    const stampMs = now();
    const stamp = Math.floor(stampMs / 1000);
    const nonce = random(sign.NONCE_BYTES);
    const { deviceId, installId } = options.device || await resolveDeviceIdentity();
    const rawQuery = sign.buildQuery({ stampMs, deviceId, installId });
    const url = `${BASE_URL}${REPLY_LIST_PATH(commentId)}?${rawQuery}`;
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'X-XS-From-Web': '0',
      'Sdk-Version': '2',
      'Content-Type': 'application/json; charset=utf-8',
      ...sign.signCommentHeaders({ rawQuery, stamp, nonce }),
    };
    const response = await transport(url, JSON.stringify({
      business_param: { book_id: seriesId, need_count: true },
      comment_id: commentId,
      comment_source: REPLY_LIST_SOURCE,
      comment_type: 4,
      count: PAGE_COUNT,
      group_id: vid,
      group_type: 30,
      ...(cursor ? { cursor } : {}),
    }), {
      headers,
      timeout: REQUEST_TIMEOUT,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      maxRedirects: 0,
      responseType: 'text',
      maxContentLength: MAX_RESPONSE_BYTES,
    });
    const raw = typeof response?.data === 'string' ? response.data : JSON.stringify(response?.data ?? null);
    let payload;
    try { payload = parseCommentJson(raw); } catch (_) {
      return { ...base, notice: '回复接口返回了非 JSON 内容' };
    }
    const code = Number(payload?.code ?? payload?.Code ?? -1);
    if (code !== 0) return { ...base, notice: `回复接口拒绝请求（code=${code}）` };
    const data = payload?.data || {};
    const list = Array.isArray(data.reply_list) ? data.reply_list : [];
    const items = list.map(mapReply).filter(Boolean);
    const info = data.comment_list_info && typeof data.comment_list_info === 'object' ? data.comment_list_info : {};
    return {
      success: true,
      items,
      total: Number(info.total) || items.length,
      has_more: Boolean(info.has_more),
      cursor: str(info.cursor),
      notice: items.length ? '' : '暂无回复',
      error: '',
    };
  } catch (error) {
    const notice = error?.code === 'ECONNABORTED' || error?.name === 'TimeoutError' || error?.code === 'ERR_CANCELED'
      ? '回复加载超时，请稍后重试'
      : '回复加载失败，请检查网络后重试';
    return { ...base, notice, error: notice };
  }
}

// 剧评回评（整季评论下的回复）。经实扫（2026-11-25，多窗口观测）：
//   - reply/list 对剧评 comment_id 的 601/501 组合即使在 601 评论通道开启窗口内
//     仍返回 103001 或空（上游未对匿名 API 暴露剧评回复数据）；
//   - 504（分集评论回复通道）对剧评 comment_id 返回 code=0 但恒为空。
// 因此按候选顺序尝试，全部无数据时给友好提示；上游若未来放行，调整候选即可。
const BASE_URL_HOST = 'api5-normal-sinfonlineb.fqnovel.com';
const SERIES_REPLY_CANDIDATES = [
  { host: 'api5-normal-lf.fqnovel.com', source: 601, commentType: 2, groupType: 4 },
  { host: 'api5-normal-lf.fqnovel.com', source: 601, commentType: 2, groupType: 30 },
  { host: BASE_URL_HOST, source: 504, commentType: 4, groupType: 30 },
];

/**
 * 拉取某条剧评下的回复列表（只读，匿名可调用）。
 * @returns {Promise<{success:boolean, items:Array, total:number, has_more:boolean, cursor:string, notice:string, error:string}>}
 */
async function fetchSeriesCommentReplies(options = {}) {
  const base = { success: false, items: [], total: 0, has_more: false, cursor: '', notice: '', error: '' };
  const seriesId = str(options.seriesId);
  const commentId = str(options.commentId);
  const cursor = str(options.cursor);
  if (!/^\d{6,30}$/.test(seriesId) || !/^\d{6,30}$/.test(commentId)) {
    return { ...base, notice: '仅红果来源的剧评支持查看回复' };
  }
  const transport = options.transport || axios.post;
  const now = options.now || Date.now;
  const random = options.random || crypto.randomBytes;
  try {
    const { deviceId, installId } = options.device || await resolveDeviceIdentity();
    let lastNotice = '';
    for (const candidate of SERIES_REPLY_CANDIDATES) {
      const stampMs = now();
      const stamp = Math.floor(stampMs / 1000);
      const nonce = random(sign.NONCE_BYTES);
      const rawQuery = sign.buildQuery({ stampMs, deviceId, installId });
      const url = `https://${candidate.host}${REPLY_LIST_PATH(commentId)}?${rawQuery}`;
      const headers = {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'X-XS-From-Web': '0',
        'Sdk-Version': '2',
        'Content-Type': 'application/json; charset=utf-8',
        'Comment-Source': String(candidate.source),
        'Server-Channel': '0',
        ...sign.signCommentHeaders({ rawQuery, stamp, nonce }),
      };
      const body = {
        business_param: { book_id: seriesId, need_count: true },
        comment_id: commentId,
        comment_source: candidate.source,
        comment_type: candidate.commentType,
        count: PAGE_COUNT,
        group_id: seriesId,
        group_type: candidate.groupType,
        ...(cursor ? { cursor } : {}),
      };
      const response = await transport(url, JSON.stringify(body), {
        headers,
        timeout: REQUEST_TIMEOUT,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        maxRedirects: 0,
        responseType: 'text',
        maxContentLength: MAX_RESPONSE_BYTES,
      });
      const raw = typeof response?.data === 'string' ? response.data : JSON.stringify(response?.data ?? null);
      let payload;
      try { payload = parseCommentJson(raw); } catch (_) {
        return { ...base, notice: '回复接口返回了非 JSON 内容' };
      }
      const code = Number(payload?.code ?? payload?.Code ?? -1);
      const data = payload?.data || {};
      const list = Array.isArray(data.reply_list) ? data.reply_list : [];
      if (code === 0 && list.length) {
        const items = list.map(mapReply).filter(Boolean);
        const info = data.comment_list_info && typeof data.comment_list_info === 'object' ? data.comment_list_info : {};
        return {
          success: true,
          items,
          total: Number(info.total) || items.length,
          has_more: Boolean(info.has_more),
          cursor: str(info.cursor),
          notice: '',
          error: '',
        };
      }
      lastNotice = code === 0 ? '暂无回复' : `回复服务暂时不可用（code=${code}），请稍后再试`;
    }
    return { ...base, notice: lastNotice || '暂无回复' };
  } catch (error) {
    const notice = error?.code === 'ECONNABORTED' || error?.name === 'TimeoutError' || error?.code === 'ERR_CANCELED'
      ? '回复加载超时，请稍后重试'
      : '回复加载失败，请检查网络后重试';
    return { ...base, notice, error: notice };
  }
}

function mapReply(raw) {
  // 一级评论的 common 键为小写，回复为大写 Common（服务端历史不一致），两边都试
  const common = raw?.common && typeof raw.common === 'object' ? raw.common
    : (raw?.Common && typeof raw.Common === 'object' ? raw.Common : {});
  const content = common.content && typeof common.content === 'object' ? common.content : {};
  const baseInfo = common.user_info?.base_info || {};
  const stat = raw?.stat && typeof raw.stat === 'object' ? raw.stat : {};
  const replyToUser = raw?.reply_to_user_info?.base_info || {};
  const replyId = str(raw?.reply_id);
  const text = str(content.text);
  if (!replyId || !text) return null;
  // 楼中楼：回复目标是另一条回复时，补「回复 @某人」前缀
  const toReplyId = str(raw?.reply_to_reply_id);
  const toUserName = str(replyToUser.user_name);
  const displayText = toReplyId && toReplyId !== '0' && toUserName
    ? `回复 @${toUserName}：${text}`
    : text;
  return {
    reply_id: replyId,
    text: displayText,
    user_name: str(baseInfo.user_name) || '红果用户',
    user_avatar: str(baseInfo.user_avatar),
    digg_count: Number(stat.digg_count) || 0,
    created_at: toMs(common.create_timestamp),
  };
}

module.exports = {
  fetchVideoComments, fetchCommentReplies, likeVideoComment, fetchSeriesComments, fetchSeriesCommentReplies,
  buildCommentBody, mapComment, mapReply, parseCommentJson, postCommentWrite,
  BASE_URL, COMMENT_PATH, DO_ACTION_PATH, REPLY_LIST_PATH, REPLY_LIST_SOURCE, SERIES_COMMENT_SOURCE, USER_AGENT, PAGE_COUNT,
};