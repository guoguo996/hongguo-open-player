// SPDX-License-Identifier: GPL-3.0-only
// Playback source orchestrator: SDK helper channel first (survives the
// upstream anonymous JS-signature blocking), then the legacy App channel.
const logger = require('../services/logger');
const appSource = require('./app-source');
const sdkPlayback = require('./sdk-playback');

async function fetchPlayUrl(vid, options = {}) {
  try {
    const info = await sdkPlayback.fetchSdkPlayUrl(vid, options);
    logger.info('PlaySource', `SDK helper 取源成功: vid=${vid}, quality=${info.quality || 'auto'}, 候选=${info.variants?.length || 1}`);
    return info;
  } catch (error) {
    if (options.signal?.aborted || error.name === 'AbortError') throw error;
    logger.warn('PlaySource', `SDK helper 取源失败（${error.code || 'UNKNOWN'}: ${error.message}），回落 App 通道: vid=${vid}`);
  }
  return appSource.fetchAppPlayUrl(vid, options);
}

module.exports = { fetchPlayUrl };
