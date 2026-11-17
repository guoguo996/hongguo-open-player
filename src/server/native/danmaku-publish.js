// SPDX-License-Identifier: GPL-3.0-only
// 发送弹幕（写操作，仅由用户 UI 主动触发）。
//
// ⚠️ 未验证实现：端点 /novel/commentapi/comment/add/v1/ 来自对闭源 hgplayer 的
// 二进制推断（docs/hongguo-player-architecture.md §4.1），公开仓库中没有任何
// 可对照的发送实现。请求体结构参照本仓库已验证的弹幕列表 body（danmaku.js
// buildBody）补上 content/offset_time 推得。上游随时可能拒绝或变更；
// 因此所有失败都转成中文 notice，且结果恒带 unverified:true 供界面提示。
//
// 签名复用已验证的评论族（danmaku-sign.js，73532），与列表请求的差异：
//   - X-SS-STUB 不再为空，而是 md5(请求体) 大写 hex（带 body 的评论写请求惯例）；
//   - 必须携带扫码登录后的 Cookie（sessionid 等），匿名发送预期会被拒。
'use strict';

const axios = require('axios');
const crypto = require('node:crypto');
const sign = require('./danmaku-sign');
const { getAccountService } = require('./account');
const { resolveDeviceIdentity } = require('./danmaku');

const BASE_URL = 'https://api5-normal-sinfonlineb.fqnovel.com';
const ADD_PATH = '/novel/commentapi/comment/add/v1/';
const USER_AGENT =
  'com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; ' +
  'Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)';
const MAX_SEND_LEN = 200;
const REQUEST_TIMEOUT = 15000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_DURATION_MS = 3600000;

const str = value => (value === null || value === undefined ? '' : String(value)).trim();

function cleanText(text) {
  let out = '';
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    out += code < 0x20 || code === 0x7f || char === '\u2028' || char === '\u2029' ? ' ' : char;
  }
  return out.trim();
}

/** 推断的发送 body：列表 body 去掉分页字段，补 content 与 offset_time。 */
function buildPublishBody({ vid, seriesId, text, offsetMs, durationMs }) {
  return {
    comment_source: 601,
    server_channel: 1000,
    group_id: vid,
    group_type: 30,
    comment_type: 20,
    aid: 8662,
    compliance_status: 0,
    content: { text },
    offset_time: offsetMs,
    business_param: {
      book_id: seriesId,
      playlet_item_duration: durationMs || DEFAULT_DURATION_MS,
    },
  };
}

const md5Upper = value => crypto.createHash('md5').update(value).digest('hex').toUpperCase();

/**
 * 发送一条弹幕。
 * @param {object} options
 * @param {string} options.seriesId 剧集 ID（business_param.book_id）
 * @param {string} options.vid 本集视频 ID（group_id）
 * @param {string} options.text 弹幕文本（1~200 字）
 * @param {number} options.timeSec 投放时间点（秒，相对本集开头）
 * @param {number} [options.durationSec] 本集时长（秒），用于封顶 offset
 * @returns {Promise<{success:boolean, unverified:true, notice:string, need_login?:boolean}>}
 */
async function publishDanmaku(options = {}) {
  const base = { success: false, unverified: true, notice: '', error: '' };
  const seriesId = str(options.seriesId);
  const vid = str(options.vid);
  if (!/^\d{6,30}$/.test(seriesId) || !/^\d{6,30}$/.test(vid)) {
    return { ...base, notice: '仅红果来源的剧集支持发送弹幕' };
  }
  const text = cleanText(options.text);
  if (!text) return { ...base, notice: '弹幕内容不能为空' };
  if (text.length > MAX_SEND_LEN) return { ...base, notice: `弹幕最长 ${MAX_SEND_LEN} 字，当前 ${text.length} 字` };
  const timeSec = Number(options.timeSec);
  if (!Number.isFinite(timeSec) || timeSec < 0) return { ...base, notice: '弹幕时间点无效' };
  const durationMs = Number(options.durationSec) > 0 ? Math.round(Number(options.durationSec) * 1000) : DEFAULT_DURATION_MS;
  const offsetMs = Math.min(Math.round(timeSec * 1000), durationMs);

  const account = options.account || getAccountService();
  if (!account.loggedIn()) {
    return { ...base, need_login: true, notice: '请先扫码登录红果账号后再发弹幕' };
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
    const url = `${BASE_URL}${ADD_PATH}?${rawQuery}`;
    const body = JSON.stringify(buildPublishBody({ vid, seriesId, text, offsetMs, durationMs }));
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'X-XS-From-Web': '0',
      'Sdk-Version': '2',
      'Content-Type': 'application/json; charset=utf-8',
      'Comment-Source': '601',
      'Server-Channel': '1000',
      ...sign.signCommentHeaders({ rawQuery, stamp, nonce }),
      'X-SS-STUB': md5Upper(body),
      Cookie: account._jar.cookieString(),
    };
    const response = await transport(url, body, {
      headers,
      timeout: REQUEST_TIMEOUT,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      maxRedirects: 0,
      responseType: 'text',
      maxContentLength: MAX_RESPONSE_BYTES,
    });
    const raw = typeof response?.data === 'string' ? response.data : JSON.stringify(response?.data ?? null);
    let payload;
    try { payload = JSON.parse(raw); } catch (_) {
      return { ...base, notice: '弹幕发送接口返回了非 JSON 内容（推断端点可能已失效）' };
    }
    const code = Number(payload?.code ?? payload?.Code ?? payload?.status_code ?? -1);
    if (code !== 0) {
      return { ...base, notice: `弹幕发送被拒绝（code=${code}）。该接口为社区推断实现，可能已失效或需要额外参数` };
    }
    return { success: true, unverified: true, notice: '弹幕已发送', error: '' };
  } catch (error) {
    const notice = error?.code === 'ECONNABORTED' || error?.name === 'TimeoutError' || error?.code === 'ERR_CANCELED'
      ? '弹幕发送超时，请稍后重试'
      : error?.response
        ? `弹幕发送接口不可用（HTTP ${Number.isInteger(error.response.status) ? error.response.status : '错误'}），推断端点可能已失效`
        : '弹幕发送失败，请检查网络后重试';
    return { ...base, notice };
  }
}

module.exports = { publishDanmaku, buildPublishBody, cleanText, md5Upper, BASE_URL, ADD_PATH, USER_AGENT, MAX_SEND_LEN };