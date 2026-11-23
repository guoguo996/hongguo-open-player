// 播放与下载共用的清晰度白名单（与红果上游五档片源 + 自动档对应）
const DOWNLOAD_QUALITIES = ['auto', '1080p', '720p', '540p', '480p', '360p'];

function normalizeDownloadQuality(value = 'auto') {
  if (!DOWNLOAD_QUALITIES.includes(value)) throw new Error('清晰度无效，请选择 自动、1080p、720p、540p、480p 或 360p');
  return value;
}

function meetsDownloadQuality({ width, height } = {}, quality = 'auto') {
  quality = normalizeDownloadQuality(quality);
  if (quality === 'auto') return true;
  const dimensions = [Number(width), Number(height)];
  return dimensions.every(value => Number.isFinite(value) && value > 0)
    && Math.min(...dimensions) >= Number.parseInt(quality, 10);
}

module.exports = { normalizeDownloadQuality, meetsDownloadQuality };
