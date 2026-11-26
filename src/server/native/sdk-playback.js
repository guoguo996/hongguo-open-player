// SPDX-License-Identifier: GPL-3.0-only
// SDK helper playback channel. Spawns the vendored resolve_cli.py in --serve
// JSONL mode; the helper drives the official 74532 phone_account SDK materials
// (unicorn-emulated ARM64 digest) to resolve playback models that the pure JS
// v5 signing path can no longer obtain (upstream blocked anonymous JS signing).
// Vendored materials: vendor/sdk-playback (see vendor/sdk-playback/vendor/SOURCE.md,
// upstream waligoraamodio288-rgb/hongguo-desktop-releases v1.0.104 via
// jackotom/hongguo-drama 8.3 scripts/sdk-playback).
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const logger = require('../services/logger');
const { normalizeDownloadQuality } = require('./download-quality');

const REQUEST_TIMEOUT_MS = 60000;
const MODEL_CACHE_TTL_MS = 2 * 60 * 1000;
const MODEL_CACHE_MAX = 64;
const SESSION_CRASH_COOLDOWN_MS = 60 * 1000;
const MAX_LINE_BYTES = 2 * 1024 * 1024;

let session = null;
let sessionCooldownUntil = 0;
let nextRequestId = 1;
const modelCache = new Map();
// 最近一次 SDK 通道的根因（排除冷却/超时等衍生状态）：SDK_COOLDOWN 只是崩溃后的
// 60 秒退避提示，客户端需要看到第一次失败的真实原因（缺 Python/依赖/启动崩溃等）。
let lastFatalReason = null;

function sdkError(message, code = 'SDK_PLAYBACK_FAILED') {
    return Object.assign(new Error(message), { code });
}

function recordFatalReason(error) {
    const code = String(error?.code || '');
    if (code === 'SDK_COOLDOWN' || code === 'SDK_TIMEOUT') return; // 衍生状态不覆盖根因
    // 客户端切集/超时会主动 abort 请求（AbortError），不是 SDK 通道的真实故障，
    // 记进去只会让透传提示显示误导性的 "This operation was aborted"。
    if (error?.name === 'AbortError' || /abort/i.test(String(error?.message || ''))) return;
    lastFatalReason = { code: code || 'SDK_PLAYBACK_FAILED', message: String(error?.message || '').slice(0, 240) };
}

function lastSdkFailureReason() {
    return lastFatalReason;
}

function vendorScriptPath() {
    return path.join(__dirname, '..', '..', '..', 'vendor', 'sdk-playback', 'resolve_cli.py');
}

const HELPER_IMPORT_CHECK = 'import requests, Crypto, unicorn';

// Windows 上 `python` 可能只是 Microsoft Store 的占位程序（执行即退出），
// 因此逐个探测候选解释器，只接受能导入全部依赖的那个。
function pythonCandidates() {
    const candidates = [];
    const envPython = (process.env.HONGGUO_SDK_PYTHON || '').trim();
    if (envPython) candidates.push({ command: envPython, prefix: [] });
    if (process.platform === 'win32') {
        candidates.push({ command: 'py', prefix: ['-3'] });
        candidates.push({ command: 'python', prefix: [] });
        candidates.push({ command: 'python3', prefix: [] });
        const launcher = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Launcher', 'py.exe');
        if (fs.existsSync(launcher)) candidates.push({ command: launcher, prefix: ['-3'] });
        const installRoot = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python');
        try {
            const versions = fs.readdirSync(installRoot)
                .filter(name => /^Python3\d+$/.test(name))
                .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
            for (const version of versions) {
                const exe = path.join(installRoot, version, 'python.exe');
                if (fs.existsSync(exe)) candidates.push({ command: exe, prefix: [] });
            }
        } catch { /* 目录不存在时忽略 */ }
    } else {
        candidates.push({ command: 'python3', prefix: [] });
        candidates.push({ command: 'python', prefix: [] });
    }
    return candidates;
}

function probePython(candidate) {
    try {
        const result = spawnSync(candidate.command, [...candidate.prefix, '-c', HELPER_IMPORT_CHECK], {
            stdio: 'ignore',
            timeout: 20000,
            windowsHide: true,
        });
        return !result.error && result.status === 0;
    } catch {
        return false;
    }
}

let resolvedPython = null;
function resolvePythonCommand() {
    if (resolvedPython) return resolvedPython;
    for (const candidate of pythonCandidates()) {
        if (!probePython(candidate)) continue;
        resolvedPython = candidate;
        return candidate;
    }
    throw sdkError('SDK helper 需要可用的 Python 3（需包含 requests/pycryptodome/unicorn），可用环境变量 HONGGUO_SDK_PYTHON 指定解释器路径', 'SDK_UNAVAILABLE');
}

// Packaged builds may ship a PyInstaller helper; the raw python script is the
// development default. Both speak the same --serve JSONL protocol.
function bundledHelperPaths() {
    if (!process.resourcesPath) return null;
    const base = path.join(process.resourcesPath, 'sdk-playback');
    return {
        exe: path.join(base, process.platform === 'win32' ? 'hongguo-sdk-playback.exe' : 'hongguo-sdk-playback'),
        python: path.join(base, 'python', process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python3')),
        script: path.join(base, 'resolve_cli.py'),
    };
}

function resolveHelperCommand() {
    const bundled = bundledHelperPaths();
    if (bundled && fs.existsSync(bundled.exe)) return { command: bundled.exe, baseArgs: [] };
    // PyInstaller 单文件引导器默认开启 Control Flow Guard，helper 会拒绝运行，
    // 因此 Windows 发布包改为内置嵌入式 Python 运行时 + 原始脚本。
    if (bundled && fs.existsSync(bundled.python) && fs.existsSync(bundled.script)) {
        return { command: bundled.python, baseArgs: [bundled.script] };
    }
    const script = vendorScriptPath();
    if (!fs.existsSync(script)) throw sdkError('SDK 取源物料缺失', 'SDK_UNAVAILABLE');
    const python = resolvePythonCommand();
    return { command: python.command, baseArgs: [...python.prefix, script] };
}

function resolveCacheDir() {
    const base = process.platform === 'win32'
        ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
        : (process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'));
    return path.join(base, 'hongguo-player-plus', 'sdk-playback');
}

function dropSession(cooldownMs = 0) {
    if (session && !session.child.killed) session.child.kill();
    session = null;
    if (cooldownMs > 0) sessionCooldownUntil = Date.now() + cooldownMs;
}

function ensureSession() {
    if (Date.now() < sessionCooldownUntil) {
        throw sdkError('SDK helper 暂不可用，稍后自动重试', 'SDK_COOLDOWN');
    }
    if (session && !session.child.killed) return session;

    const { command, baseArgs } = resolveHelperCommand();
    const cacheDir = resolveCacheDir();
    fs.mkdirSync(cacheDir, { recursive: true });
    const child = spawn(command, [...baseArgs, '--serve', '--cache', cacheDir], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const state = { child, buffer: '', pending: new Map() };
    session = state;

    child.stdout.on('data', (chunk) => {
        if (!session || session !== state) return;
        state.buffer += chunk.toString('utf8');
        if (state.buffer.length > MAX_LINE_BYTES) {
            logger.warn('SdkPlayback', 'SDK helper 输出异常过长，重置会话');
            dropSession(SESSION_CRASH_COOLDOWN_MS);
            return;
        }
        for (;;) {
            const nl = state.buffer.indexOf('\n');
            if (nl < 0) break;
            const line = state.buffer.slice(0, nl).trim();
            state.buffer = state.buffer.slice(nl + 1);
            if (!line) continue;
            let reply;
            try {
                reply = JSON.parse(line);
            } catch {
                logger.warn('SdkPlayback', 'SDK helper 返回无法解析的数据，重置会话');
                failPending(state, sdkError('SDK helper 返回数据无法解析', 'SDK_INVALID_RESPONSE'));
                dropSession(SESSION_CRASH_COOLDOWN_MS);
                break;
            }
            const entry = state.pending.get(reply?.id);
            if (!entry) continue;
            state.pending.delete(reply.id);
            clearTimeout(entry.timer);
            if (reply?.ok === true && reply.model && typeof reply.model === 'object'
                && typeof reply.userAgent === 'string' && reply.userAgent.trim()) {
                entry.resolve({ model: reply.model, userAgent: reply.userAgent.trim().slice(0, 512) });
            } else {
                entry.reject(sdkError(`SDK helper 取源失败：${String(reply?.error || '未知错误').slice(0, 240)}（阶段 ${String(reply?.stage || '?')}）`, 'SDK_HELPER_FAILED'));
            }
        }
    });
    child.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8').trim();
        if (text) logger.debug('SdkPlayback', `helper: ${text.slice(0, 200)}`);
    });
    child.on('error', (error) => {
        if (session !== state) return;
        logger.warn('SdkPlayback', `SDK helper 启动失败: ${error.message}`);
        failPending(state, sdkError(`SDK helper 启动失败：${error.message}`, 'SDK_UNAVAILABLE'));
        dropSession(SESSION_CRASH_COOLDOWN_MS);
    });
    child.on('close', () => {
        if (session !== state) return;
        failPending(state, sdkError('SDK helper 会话已退出', 'SDK_HELPER_FAILED'));
        dropSession(SESSION_CRASH_COOLDOWN_MS);
    });
    return state;
}

function failPending(state, error) {
    for (const entry of state.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
    }
    state.pending.clear();
}

function requestModel(vid, signal, timeoutMs = REQUEST_TIMEOUT_MS) {
    const state = ensureSession();
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason || sdkError('取源已取消', 'ERR_CANCELED'));
            return;
        }
        const id = nextRequestId++;
        const entry = { resolve, reject, timer: null };
        const finish = (fn, value) => {
            clearTimeout(entry.timer);
            signal?.removeEventListener('abort', onAbort);
            if (state.pending.get(id) === entry) state.pending.delete(id);
            fn(value);
        };
        const cancel = () => {
            // The helper has no per-request cancel; dropping the session keeps state clean.
            finish(reject, signal.reason || sdkError('SDK 取源超时', 'SDK_TIMEOUT'));
            if (session === state) dropSession(SESSION_CRASH_COOLDOWN_MS);
        };
        const onAbort = () => cancel();
        entry.timer = setTimeout(cancel, timeoutMs);
        entry.timer.unref?.();
        signal?.addEventListener('abort', onAbort, { once: true });
        state.pending.set(id, entry);
        try {
            state.child.stdin.write(JSON.stringify({ id, video: String(vid) }) + '\n');
        } catch (error) {
            finish(reject, sdkError(`SDK helper 通信失败：${error.message}`, 'SDK_HELPER_FAILED'));
            if (session === state) dropSession(SESSION_CRASH_COOLDOWN_MS);
        }
    });
}

function readCachedModel(vid, fresh) {
    if (fresh) modelCache.delete(String(vid));
    const cached = modelCache.get(String(vid));
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
        modelCache.delete(String(vid));
        return null;
    }
    return cached;
}

function storeCachedModel(vid, value) {
    modelCache.delete(String(vid));
    modelCache.set(String(vid), { value, expiresAt: Date.now() + MODEL_CACHE_TTL_MS });
    while (modelCache.size > MODEL_CACHE_MAX) {
        modelCache.delete(modelCache.keys().next().value);
    }
}

async function resolveModel(vid, signal, fresh = false) {
    const cached = fresh ? null : readCachedModel(vid, false);
    if (cached) return cached.value;
    const result = await requestModel(vid, signal);
    storeCachedModel(vid, result);
    return result;
}

async function fetchSdkPlayUrl(vid, options = {}) {
    const requestedQuality = normalizeDownloadQuality(options.quality);
    vid = String(vid || '');
    if (!/^\d{1,30}$/.test(vid)) throw new Error('分集编号无效');
    try {
        const { model, userAgent } = await resolveModel(vid, options.signal, options.refresh === true);
        const deadline = Date.now() + 12000;
        const timeoutSignal = AbortSignal.timeout(12000);
        const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
        const appSource = require('./app-source');
        const info = await appSource.parseEntryPlayInfo(vid, { video_model: model }, requestedQuality,
            options.allowLowerQuality === true && requestedQuality !== 'auto', deadline, signal,
            options.allowBytevc2 === true, options.allowHevc !== false, options.allowHevcTranscode === true);
        lastFatalReason = null; // 成功即清除历史根因，避免误导后续诊断
        if (userAgent) {
            info.userAgent = userAgent;
            if (Array.isArray(info.variants)) {
                info.variants = info.variants.map(variant => ({ ...variant, userAgent }));
            }
        }
        return info;
    } catch (error) {
        recordFatalReason(error);
        throw error;
    }
}

function clearSdkModelCache() {
    modelCache.clear();
}

function shutdownSdkPlayback() {
    dropSession();
    modelCache.clear();
}

process.on('exit', () => {
    if (session && !session.child.killed) session.child.kill();
});

module.exports = { fetchSdkPlayUrl, clearSdkModelCache, shutdownSdkPlayback, lastSdkFailureReason };
