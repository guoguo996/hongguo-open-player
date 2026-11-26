// play-source 取源编排离线单测：mock sdk/app 通道，不访问网络、不启动 helper。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 通过 require 缓存注入 mock 的 sdk-playback 与 app-source。
// 缓存键必须是 require.resolve 规范化后的本地路径（不能用 file:// URL）。
const ROOT = path.join(__dirname, '..', '..');
const SDK_PATH = path.join(ROOT, 'src', 'server', 'native', 'sdk-playback.js');
const APP_PATH = path.join(ROOT, 'src', 'server', 'native', 'app-source.js');
const PS_PATH = path.join(ROOT, 'src', 'server', 'native', 'play-source.js');

function loadPlaySource({ sdkImpl, appImpl, lastReason = null }) {
  const sdkMock = {
    fetchSdkPlayUrl: sdkImpl,
    lastSdkFailureReason: () => lastReason,
    clearSdkModelCache: () => {},
    shutdownSdkPlayback: () => {},
  };
  const appMock = { fetchAppPlayUrl: appImpl };
  require.cache[SDK_PATH] = Object.assign(new (require('module').Module)(SDK_PATH), { loaded: true, exports: sdkMock });
  require.cache[APP_PATH] = Object.assign(new (require('module').Module)(APP_PATH), { loaded: true, exports: appMock });
  delete require.cache[PS_PATH];
  return require(PS_PATH);
}

const info = { quality: 'auto', variants: [{ url: 'https://x/1.mp4' }] };

test('SDK 成功时直接返回，不触达 App 通道', async () => {
  let appCalled = false;
  const ps = loadPlaySource({ sdkImpl: async () => info, appImpl: async () => { appCalled = true; return info; } });
  const result = await ps.fetchPlayUrl('123');
  assert.equal(result, info);
  assert.equal(appCalled, false);
});

test('SDK 失败回落 App 成功时正常返回', async () => {
  const ps = loadPlaySource({
    sdkImpl: async () => { throw Object.assign(new Error('boom'), { code: 'SDK_HELPER_FAILED' }); },
    appImpl: async () => info,
  });
  const result = await ps.fetchPlayUrl('123');
  assert.equal(result, info);
});

test('双通道全败时保留 App 错误码并把 SDK 根因拼进消息', async () => {
  const ps = loadPlaySource({
    sdkImpl: async () => { throw Object.assign(new Error('SDK helper 需要可用的 Python 3'), { code: 'SDK_UNAVAILABLE' }); },
    appImpl: async () => { throw Object.assign(new Error('上游风控冷却中，稍后自动恢复'), { code: 'RATE_LIMIT_COOLDOWN', status: 503 }); },
  });
  await assert.rejects(
    () => ps.fetchPlayUrl('123'),
    error => {
      assert.equal(error.code, 'RATE_LIMIT_COOLDOWN'); // 客户端长退避逻辑依赖该码
      assert.equal(error.status, 503);
      assert.ok(error.message.includes('上游风控冷却中'));
      assert.ok(error.message.includes('SDK 通道亦不可用'));
      assert.ok(error.message.includes('需要可用的 Python 3'));
      return true;
    }
  );
});

test('SDK 处于冷却态时取模块记录的真实根因', async () => {
  const ps = loadPlaySource({
    sdkImpl: async () => { throw Object.assign(new Error('SDK helper 暂不可用，稍后自动重试'), { code: 'SDK_COOLDOWN' }); },
    lastReason: { code: 'SDK_HELPER_FAILED', message: 'helper 崩溃：阶段 2（unicorn digest）' },
    appImpl: async () => { throw Object.assign(new Error('上游风控冷却中，稍后自动恢复'), { code: 'RATE_LIMIT_COOLDOWN', status: 503 }); },
  });
  await assert.rejects(
    () => ps.fetchPlayUrl('123'),
    error => {
      assert.ok(error.message.includes('helper 崩溃：阶段 2'));
      return true;
    }
  );
});

test('App 通道错误是客户端取消时原样抛出，不拼接 SDK 信息', async () => {
  const ps = loadPlaySource({
    sdkImpl: async () => { throw Object.assign(new Error('boom'), { code: 'SDK_HELPER_FAILED' }); },
    appImpl: async () => { throw Object.assign(new Error('取源已取消'), { name: 'AbortError' }); },
  });
  await assert.rejects(
    () => ps.fetchPlayUrl('123'),
    error => {
      assert.equal(error.name, 'AbortError');
      assert.ok(!error.message.includes('SDK'));
      return true;
    }
  );
});
