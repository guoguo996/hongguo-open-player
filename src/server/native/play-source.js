// SPDX-License-Identifier: GPL-3.0-only
// Playback source orchestrator: SDK helper channel first (survives the
// upstream anonymous JS-signature blocking), then the legacy App channel.
const logger = require('../services/logger');
const appSource = require('./app-source');
const sdkPlayback = require('./sdk-playback');

// SDK 根因摘要：冷却状态（SDK_COOLDOWN）本身不含原因，取模块记录的真实根因；
// 取消/超时类中断不是通道故障，不拼接（避免客户端看到误导的 aborted 提示）。
function sdkRootReason(sdkFailure) {
  if (!sdkFailure) return null;
  if (sdkFailure.code === 'SDK_COOLDOWN' || sdkFailure.code === 'SDK_TIMEOUT') {
    const recorded = sdkPlayback.lastSdkFailureReason();
    return recorded && !/abort/i.test(recorded.message || '') ? recorded : null;
  }
  if (/abort/i.test(String(sdkFailure.message || ''))) return null;
  return { code: String(sdkFailure.code || 'SDK_PLAYBACK_FAILED'), message: sdkFailure.message };
}

async function fetchPlayUrl(vid, options = {}) {
  let sdkFailure = null;
  try {
    const info = await sdkPlayback.fetchSdkPlayUrl(vid, options);
    logger.info('PlaySource', `SDK helper 取源成功: vid=${vid}, quality=${info.quality || 'auto'}, 候选=${info.variants?.length || 1}`);
    return info;
  } catch (error) {
    if (options.signal?.aborted || error.name === 'AbortError') throw error;
    sdkFailure = error;
    logger.warn('PlaySource', `SDK helper 取源失败（${error.code || 'UNKNOWN'}: ${error.message}），回落 App 通道: vid=${vid}`);
  }
  try {
    return await appSource.fetchAppPlayUrl(vid, options);
  } catch (error) {
    if (options.signal?.aborted || error.name === 'AbortError') throw error;
    // App 通道也失败：保留 App 错误码（客户端长退避/自动换设备逻辑依赖它不变），
    // 把 SDK 根因拼进消息透传，避免客户端只看到"风控冷却中"而掩盖真实环境问题。
    const root = sdkRootReason(sdkFailure);
    if (root?.message && !String(error.message).includes('SDK')) {
      error.message = `${error.message}；SDK 通道亦不可用（${root.message}）`;
    }
    throw error;
  }
}

module.exports = { fetchPlayUrl };
