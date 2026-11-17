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
  const text = str(content.text);
  if (!text) return null;
  return {
    comment_id: str(comment.comment_id),
    text,
    user_name: str(baseInfo.user_name) || '红果用户',
    user_avatar: str(baseInfo.user_avatar),
    digg_count: Number(stat.digg_count) || 0,
    reply_count: Number(stat.reply_count) || 0,
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

module.exports = { fetchVideoComments, buildCommentBody, mapComment, parseCommentJson, BASE_URL, COMMENT_PATH, USER_AGENT, PAGE_COUNT };