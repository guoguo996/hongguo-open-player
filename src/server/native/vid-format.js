// SPDX-License-Identifier: GPL-3.0-only
// 分集 vid 合法性校验。旧格式为 1~30 位纯数字；2026-11 起新剧在官网分集列表
// 启用 v1_ 前缀字符串 vid（实测样例 v1_jVYv3CXvRYrApnPTvwai4Sb4eoY，
// 字符集 [A-Za-z0-9_-]）。全链（分集列表/取流/预取/流代理）统一引用本模块，
// 避免各处正则漂移。
const VID_PATTERN = /^(?:v1_[A-Za-z0-9_-]{1,64}|\d{1,30})$/;

function isValidVid(value) {
  return VID_PATTERN.test(String(value ?? ''));
}

module.exports = { VID_PATTERN, isValidVid };
