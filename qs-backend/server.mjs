// qs-backend —— 汽水音乐本地后端(魔改形态:客户端二进制不动,签名走官方 bdms.node)
//
//   GET  /api/health                状态
//   GET  /api/search?q=&limit=      搜索(免签名)
//   GET  /api/playlist/:id          歌单详情(免签名)
//   GET  /api/related/:trackId      推荐流(免签名)
//   GET  /api/stream/:trackId       取流:签名 track_v2 → 下载 → 解密 → 落盘(需 SVIP cookie)
//   GET  /api/file/:name            播放已解密文件(支持 Range)
//   GET  /api/cookie                Cookie 状态
//   POST /api/cookie {cookie}       导入 Cookie(模组首次配对时推送)
//   POST /api/pc {path,params,body} 签名 PC 接口白名单代理(仅 /luna/pc/*)
//
// 配置:同目录 config.json(首启自动生成)——cookie、device_id、client_dir、port。
// 依赖:官方客户端 bdms.node(自动探测 Soda Music 安装位置)。
'use strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { TrackDecryptor } from './qishui-audio-decryptor/track-decryptor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 配置(config.json 同目录持久化;首启自动生成)──
const CONFIG_PATH = path.join(__dirname, 'config.json');
const CONFIG_VERSION = 1;

function detectClientDir() {
    const candidates = [];
    const add = value => { if (value && !candidates.includes(value)) candidates.push(value); };
    add(process.env.QISHUI_CLIENT_DIR || '');
    try {
        // 注册表卸载信息里记录了安装位置(Inno Setup 的 InstallLocation)
        const out = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s /v InstallLocation 2>nul', { encoding: 'utf8' }).toString();
        const lines = out.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (/SodaMusic|汽水/i.test(lines[i]) && lines[i + 1] && /InstallLocation/.test(lines[i + 1])) {
                const m = /InstallLocation\s+REG_SZ\s+(.+)/.exec(lines[i + 1]);
                if (m) add(m[1].trim());
            }
        }
    } catch { /* 注册表没有就算了 */ }
    try {
        const localAppData = process.env.LOCALAPPDATA || '';
        if (localAppData) {
            const root = path.join(localAppData, 'Programs', 'Soda Music');
            if (fs.existsSync(root)) {
                const versions = fs.readdirSync(root).filter(name => /^\d+\.\d+\.\d+/.test(name)).sort();
                add(versions.length ? path.join(root, versions.at(-1)) : root);
            }
        }
    } catch { /* 目录不存在就算了 */ }
    for (const drive of ['C', 'D', 'E', 'F']) {
        try {
            const root = `${drive}:\\Soda Music`;
            if (fs.existsSync(root)) {
                const versions = fs.readdirSync(root).filter(name => /^\d+\.\d+\.\d+/.test(name)).sort();
                add(versions.length ? path.join(root, versions.at(-1)) : root);
            }
        } catch { /* 无该盘符 */ }
    }
    return candidates.find(dir => fs.existsSync(path.join(dir, 'resources', 'app.asar.unpacked', 'bdms.node'))) || '';
}

function loadConfig() {
    let config = {};
    try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* 首启 */ }
    if (!config.version) config.version = CONFIG_VERSION;
    if (!config.port) config.port = Number(process.env.PORT || 8787);
    if (!config.device_id) {
        // 16 位数字设备身份,与官方客户端同形;首启生成后持久化
        let did = String(crypto.randomInt(1, 9));
        while (did.length < 16) did += String(crypto.randomInt(0, 10));
        config.device_id = did;
    }
    if (!config.client_dir) config.client_dir = detectClientDir();
    if (config.cookie == null) config.cookie = process.env.QISHUI_COOKIE || '';
    return config;
}

const CONFIG = loadConfig();
function saveConfig() {
    const temporary = CONFIG_PATH + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(CONFIG, null, 2));
    fs.renameSync(temporary, CONFIG_PATH);
}
saveConfig();

const BDMS_PATH = path.join(CONFIG.client_dir, 'resources', 'app.asar.unpacked', 'bdms.node');
const CACHE_DIR = path.join(__dirname, 'cache');
const APP_VERSION = '3.7.0', VERSION_CODE = '30070000', TRON_BUILD = '30070000';
const UA_PC = `LunaPC/${APP_VERSION}(${TRON_BUILD})`;
const UA_MOBILE = 'com.luna.music/8986 (Linux; U; Android 14; zh_CN; Pixel 8; build/TQ3A; tt-ok/3.12.0.2)';
fs.mkdirSync(CACHE_DIR, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
log(`配置: port=${CONFIG.port} did=${CONFIG.device_id} client=${CONFIG.client_dir || '(未找到)'} cookie=${CONFIG.cookie ? CONFIG.cookie.length + 'B' : '无'}`);

// ── 签名桥接(spawn 一次签一个,签名覆盖 URL + 全部请求头)──
function signRequest(url, method, body, headers) {
    if (!fs.existsSync(BDMS_PATH)) return Promise.reject(new Error('未找到官方客户端 bdms.node: ' + BDMS_PATH + ' —— 请在 config.json 里把 client_dir 指向汽水音乐安装目录'));
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ url, method, body, headers, ts_ms: Date.now() });
        const child = spawn(process.execPath, [path.join(__dirname, 'mssdk-bridge.mjs')], {
            env: { ...process.env, QISHUI_CLIENT_DIR: CONFIG.client_dir, QISHUI_DEVICE_ID: CONFIG.device_id, QISHUI_BDMS_PATH: BDMS_PATH },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '', err = '';
        child.stdout.on('data', c => out += c);
        child.stderr.on('data', c => err += c);
        child.on('close', code => {
            if (code !== 0) return reject(new Error('签名失败: ' + err.slice(0, 200)));
            try { resolve(JSON.parse(out).headers); } catch { reject(new Error('签名输出异常: ' + out.slice(0, 120))); }
        });
        child.stdin.write(payload);
        child.stdin.end();
    });
}

// ── HTTP 工具 ──
function request(url, { method = 'GET', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.request(u, { method, headers }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.setTimeout(20000, () => req.destroy(new Error('timeout')));
        if (body) req.write(body);
        req.end();
    });
}
const md5Upper = s => crypto.createHash('md5').update(s).digest('hex').toUpperCase();
const mobileParams = extra => ({ aid: '386088', app_name: 'luna', device_id: CONFIG.device_id, iid: String(Number(CONFIG.device_id) + 3), version_code: '8986', channel: 'google_play', device_platform: 'android', device_type: 'Pixel 8', os_version: '14', ac: 'wifi', tz_name: 'Asia/Shanghai', cdid: '', ...extra });
const pcParams = extra => ({ aid: '386088', app_name: 'luna_pc', region: 'cn', geo_region: 'cn', os_region: 'cn', sim_region: '', device_id: CONFIG.device_id, cdid: '', iid: CONFIG.device_id, version_name: APP_VERSION, version_code: VERSION_CODE, channel: 'official', build_mode: 'master', network_carrier: '', ac: 'wifi', tz_name: 'Asia/Shanghai', resolution: '', device_platform: 'windows', device_type: 'Windows', os_version: '10.0.26200', fp: CONFIG.device_id, ...extra });
const qs = params => new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)])).toString();
const readBody = req => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
});

// ── 曲目提取(在各响应结构里深搜 track_wrapper.track)──
function collectTracks(node, out = new Map(), depth = 0) {
    if (!node || typeof node !== 'object' || depth > 8) return out;
    if (Array.isArray(node)) { for (const item of node) collectTracks(item, out, depth + 1); return out; }
    const tw = node.track_wrapper ?? (node.entity && node.entity.track_wrapper);
    const t = tw?.track ?? (node.track && node.track.id && node.track.name ? node.track : null);
    if (t && t.id && t.name) {
        if (!out.has(String(t.id))) out.set(String(t.id), {
            id: String(t.id), name: t.name, duration_ms: t.duration ?? 0,
            artists: (t.artists ?? []).map(a => a.name).join('/'),
            album: t.album?.name ?? '',
            vip: !!(t.label_info?.only_vip_playable || t.label_info?.only_vip_download),
            audition: t.audition_info ?? null,
        });
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') collectTracks(v, out, depth + 1);
    return out;
}

// ── 免签名数据面 ──
async function apiSearch(q, limit = 20) {
    const url = `https://api.qishui.com/luna/search/track?${qs(mobileParams({ q, cursor: 0, count: Math.min(50, limit) }))}`;
    const r = await request(url, { headers: { Accept: 'application/json', 'User-Agent': UA_MOBILE, Cookie: CONFIG.cookie } });
    return [...collectTracks(JSON.parse(r.text)).values()].slice(0, limit);
}
async function apiPlaylist(id) {
    const url = `https://api.qishui.com/luna/playlist/detail?${qs(mobileParams({ playlist_id: id }))}`;
    const r = await request(url, { headers: { Accept: 'application/json', 'User-Agent': UA_MOBILE, Cookie: CONFIG.cookie } });
    const j = JSON.parse(r.text);
    return { id: String(id), name: j.playlist?.name ?? '', track_count: [...collectTracks(j).values()].length, tracks: [...collectTracks(j).values()] };
}
async function apiRelated(trackId) {
    const url = `https://api.qishui.com/luna/media/related?${qs(mobileParams())}`;
    const r = await request(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': UA_MOBILE, Cookie: CONFIG.cookie }, body: JSON.stringify({ track_id: String(trackId), media_type: 'track' }) });
    return [...collectTracks(JSON.parse(r.text)).values()].filter(t => t.id !== String(trackId));
}

// ── 签名取流面 ──
async function apiTrackV2(trackId) {
    const body = JSON.stringify({ track_id: String(trackId), media_type: 'track', queue_type: 'favorite_track_playlist', scene_name: 'library' });
    const url = `https://api.qishui.com/luna/pc/track_v2?${qs(pcParams())}`;
    const headers = {
        'Accept': 'application/json,text/plain,*/*',
        'User-Agent': UA_PC,
        'Content-Type': 'application/json; charset=utf-8',
        'Cookie': CONFIG.cookie,
        'Referer': 'https://www.qishui.com/',
        'x-ss-stub': md5Upper(body),
        'x-luna-background-type': 'foreground',
        'x-luna-is-background-req': '0',
        'x-luna-is-local-user': '1',
    };
    const sig = await signRequest(url, 'POST', body, headers);
    headers['X-Helios'] = sig['X-Helios'] ?? sig['x-helios'];
    headers['X-Medusa'] = sig['X-Medusa'] ?? sig['x-medusa'];
    const r = await request(url, { method: 'POST', headers, body });
    if (!r.text.trim()) throw new Error('track_v2 空响应(签名或设备身份不匹配)');
    return JSON.parse(r.text);
}

const decryptor = new TrackDecryptor();
async function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { Accept: '*/*', Referer: 'https://www.qishui.com/' } }, res => {
            if (res.statusCode >= 300 && res.headers.location) return resolve(fetchBuffer(res.headers.location));
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
    });
}
async function streamTrack(trackId) {
    const cacheKey = crypto.createHash('sha1').update(String(trackId)).digest('hex').slice(0, 16);
    const cached = fs.readdirSync(CACHE_DIR).find(f => f.startsWith(cacheKey + '__'));
    if (cached) {
        const metaPath = path.join(CACHE_DIR, cacheKey + '.meta.json');
        const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
        return { file: path.join(CACHE_DIR, cached), cached: true, name: cached.split('__').slice(1).join('__'), meta };
    }
    if (!CONFIG.cookie) throw new Error('后端尚未配置 Cookie:请先在游戏里登录汽水账号(模组会自动推送),或 POST /api/cookie 导入');
    const j = await apiTrackV2(trackId);
    const track = j.track ?? {};
    const purl = j.track_player?.url_player_info;
    if (!purl) throw new Error('无 url_player_info(权益或签名问题): ' + JSON.stringify(j).slice(0, 150));
    const pj = JSON.parse((await fetchBuffer(purl)).toString('utf8'));
    const list = pj.Result?.Data?.PlayInfoList ?? [];
    const best = list.slice().sort((a, b) => (b.Bitrate ?? 0) - (a.Bitrate ?? 0))[0];
    if (!best?.MainPlayUrl) throw new Error('PlayInfoList 为空');
    const enc = await fetchBuffer(best.MainPlayUrl);
    const result = decryptor.decrypt({ encryptedBuffer: enc, spadeA: best.PlayAuth, media: { title: track.name ?? trackId, artist: (track.artists ?? []).map(a => a.name).join('/') } });
    const out = path.join(CACHE_DIR, `${cacheKey}__${result.fileName}`);
    fs.writeFileSync(out, result.buffer);
    const meta = {
        track_id: String(trackId), name: track.name, artist: (track.artists ?? []).map(a => a.name).join('/'),
        duration_ms: track.duration, bitrate_kbps: Math.round((best.Bitrate ?? 0) / 1000), format: best.Format,
        encrypted: best.EncryptionMethod ?? '', size_mb: +(result.buffer.length / 1024 / 1024).toFixed(2),
        qualities: list.map(x => `${Math.round((x.Bitrate ?? 0) / 1000)}k`),
    };
    fs.writeFileSync(path.join(CACHE_DIR, cacheKey + '.meta.json'), JSON.stringify(meta, null, 1));
    return { file: out, cached: false, name: result.fileName, meta };
}

// ── HTTP 服务 ──
const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj, null, 1)); };
    try {
        if (p === '/api/health') return send(200, {
            ok: true, device_id: CONFIG.device_id,
            bdms: fs.existsSync(BDMS_PATH), client_dir: CONFIG.client_dir,
            has_cookie: !!CONFIG.cookie, cookie_len: CONFIG.cookie.length,
            cache_files: fs.readdirSync(CACHE_DIR).filter(f => !f.endsWith('.meta.json')).length,
        });
        if (p === '/api/cookie') {
            if (req.method === 'POST') {
                const payload = JSON.parse(await readBody(req));
                const cookie = String(payload.cookie || '').trim();
                if (!/(?:^|;\s*)(?:sessionid|sessionid_ss|sid_guard|sid_tt)=/.test(cookie)) {
                    return send(400, { ok: false, error: 'Cookie 里没有登录凭据(sessionid/sessionid_ss/sid_guard/sid_tt)' });
                }
                CONFIG.cookie = cookie;
                saveConfig();
                log('Cookie 已更新(' + cookie.length + 'B),来源: ' + (payload.source || 'api'));
                return send(200, { ok: true, cookie_len: cookie.length });
            }
            return send(200, { has_cookie: !!CONFIG.cookie, cookie_len: CONFIG.cookie.length });
        }
        if (p === '/api/search') {
            const q = u.searchParams.get('q'); if (!q) return send(400, { error: '缺少 q' });
            return send(200, { query: q, songs: await apiSearch(q, Number(u.searchParams.get('limit') || 20)) });
        }
        if (p.startsWith('/api/playlist/')) return send(200, await apiPlaylist(p.split('/')[3]));
        if (p.startsWith('/api/related/')) return send(200, { track_id: p.split('/')[3], related: await apiRelated(p.split('/')[3]) });
        if (p === '/api/pc') {
            // 签名 PC 接口白名单代理:模组发 {path, params, body},这里拼 URL、bdms 签名、带 cookie 转发。
            const spec = JSON.parse(await readBody(req) || '{}');
            const pcPath = String(spec.path || '');
            if (!pcPath.startsWith('/luna/pc/')) return send(400, { error: 'path 不在白名单(仅 /luna/pc/*)' });
            const jsonBody = spec.body ? JSON.stringify(spec.body) : null;
            const url = `https://api.qishui.com${pcPath}?${qs({ ...pcParams(), ...(spec.params || {}) })}`;
            const headers = {
                'Accept': 'application/json,text/plain,*/*',
                'User-Agent': UA_PC,
                'Cookie': CONFIG.cookie,
                'Referer': 'https://www.qishui.com/',
                'x-luna-background-type': 'foreground',
                'x-luna-is-background-req': '0',
                'x-luna-is-local-user': '1',
            };
            if (jsonBody) {
                headers['Content-Type'] = 'application/json; charset=utf-8';
                headers['x-ss-stub'] = md5Upper(jsonBody);
            }
            const sig = await signRequest(url, jsonBody ? 'POST' : 'GET', jsonBody, headers);
            headers['X-Helios'] = sig['X-Helios'] ?? sig['x-helios'];
            headers['X-Medusa'] = sig['X-Medusa'] ?? sig['x-medusa'];
            const r = await request(url, { method: jsonBody ? 'POST' : 'GET', headers, body: jsonBody });
            let parsed; try { parsed = JSON.parse(r.text); } catch { parsed = { _raw: r.text.slice(0, 500) }; }
            log('PC', pcPath, '->', r.status);
            return send(200, { http_status: r.status, body: parsed });
        }
        if (p.startsWith('/api/stream/')) {
            const r = await streamTrack(p.split('/')[3]);
            return send(200, { status: 'ok', file_url: '/api/file/' + encodeURIComponent(path.basename(r.file)), cached: r.cached, ...r.meta });
        }
        if (p.startsWith('/api/file/')) {
            const name = path.basename(decodeURIComponent(p.slice(10)));
            const file = path.join(CACHE_DIR, name);
            if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
            const size = fs.statSync(file).size;
            const range = req.headers.range;
            const base = { 'Content-Type': 'audio/mp4', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
            if (range) {
                const m = /^bytes=(\d*)-(\d*)$/.exec(range);
                let s = m?.[1] ? Number(m[1]) : 0, e = m?.[2] ? Number(m[2]) : size - 1;
                e = Math.min(e, size - 1);
                res.writeHead(206, { ...base, 'Content-Range': `bytes ${s}-${e}/${size}`, 'Content-Length': e - s + 1 });
                return fs.createReadStream(file, { start: s, end: e }).pipe(res);
            }
            res.writeHead(200, { ...base, 'Content-Length': size });
            return fs.createReadStream(file).pipe(res);
        }
        send(404, { error: 'not found', endpoints: ['/api/health', '/api/cookie', '/api/search?q=', '/api/playlist/:id', '/api/related/:trackId', '/api/pc', '/api/stream/:trackId', '/api/file/:name'] });
    } catch (e) {
        log('ERROR', p, String(e.message || e).slice(0, 200));
        send(500, { error: String(e.message || e) });
    }
});
server.listen(CONFIG.port, '127.0.0.1', () => log(`qs-backend 就绪 http://127.0.0.1:${CONFIG.port} | did=${CONFIG.device_id} | bdms=${fs.existsSync(BDMS_PATH) ? 'OK' : '缺失(' + CONFIG.client_dir + ')'} | cookie=${CONFIG.cookie ? CONFIG.cookie.length + 'B' : '无'}`));
