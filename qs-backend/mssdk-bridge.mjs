#!/usr/bin/env node
// 汽水应用签名桥接器（Windows / macOS 客户端机器上运行）。
//
// 结论先说：**不需要逆向 metasecml.dll**。官方客户端自带
// `resources/app.asar.unpacked/bdms.node`，它导出的
// `init({deviceId})` + `generateHttpSignatureHeaders(url, headerLines)` 就是
// 客户端在 `src/app.ts` 里给每个请求加签的同一条链路（sourcemap 泄漏源码里可读到）。
//
// 契约（与 libresoda 的 SignRequest / SignResponse 一致，可被
// `signer-service.mjs --backend=command` 或 `CommandSignature` 直接调用）：
//
//   stdin : {"url":"https://api.qishui.com/luna/pc/track_v2?…",
//            "method":"POST",
//            "body":"{\"track_id\":\"…\"}",
//            "headers":{"content-type":"…","cookie":"…","x-ss-stub":"…","…":"…"},
//            "ts_ms":1789435000000}
//   stdout: {"headers":{"X-Helios":"…","X-Medusa":"…"}}
//
// 关键点（实测）：
//   * 签名覆盖 URL + **将要发送的每一个请求头**，所以 headers 必须与实际发送的一致
//     （尤其 `x-ss-stub` = body 的 MD5 大写、`cookie`）；
//   * `deviceId` 必须是抓包时那台设备的 did，否则服务端判空；
//   * 生成的头部名是 `X-Helios` / `X-Medusa`，写回请求即可。
//
// 环境变量：
//   QISHUI_CLIENT_DIR   客户端安装目录（默认探测 %LOCALAPPDATA%\Programs\Soda Music\<最新版本>）
//   QISHUI_DEVICE_ID    设备 did（抓包得到；也可由调用方放在请求的 headers/url 里）
//   QISHUI_BDMS_PATH    直接指定 bdms.node 路径（默认 <client>/resources/app.asar.unpacked/bdms.node）

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function resolveClientDir() {
    const explicit = (process.env.QISHUI_CLIENT_DIR || '').trim()
    if (explicit) return explicit
    const roots = [
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Soda Music'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', '汽水音乐'),
        path.join(os.homedir(), 'Applications'), // macOS
    ].filter(Boolean)
    for (const root of roots) {
        if (!fs.existsSync(root)) continue
        const versions = fs.readdirSync(root).filter(name => /^\d+\.\d+\.\d+/.test(name))
        if (versions.length > 0) return path.join(root, versions.sort().at(-1))
        return root
    }
    return ''
}

function resolveBdmsPath() {
    const explicit = (process.env.QISHUI_BDMS_PATH || '').trim()
    if (explicit) return explicit
    const dir = resolveClientDir()
    if (!dir) return ''
    const candidates = [
        path.join(dir, 'resources', 'app.asar.unpacked', 'bdms.node'),
        path.join(dir, 'resources', 'app.asar.unpacked', 'mssdk', 'bdms.node'),
    ]
    return candidates.find(candidate => fs.existsSync(candidate)) || ''
}

let bdms = null
let initialisedDeviceId = ''

function loadBdms() {
    if (bdms) return bdms
    const bdmsPath = resolveBdmsPath()
    if (!bdmsPath) throw new Error('找不到 bdms.node，请设置 QISHUI_BDMS_PATH 或 QISHUI_CLIENT_DIR')
    bdms = require(bdmsPath)
    return bdms
}

function ensureInit(deviceId) {
    if (initialisedDeviceId === deviceId) return
    loadBdms().init({ deviceId })
    initialisedDeviceId = deviceId
}

/** 从 device_id / fp / did 里找出设备号；调用方没给就回退到环境变量。 */
function deviceIdFrom(request) {
    const fromHeaders = request.headers?.device_id || request.headers?.['device-id']
    if (fromHeaders) return String(fromHeaders).trim()
    try {
        const url = new URL(String(request.url || ''))
        for (const key of ['device_id', 'fp', 'did']) {
            const value = url.searchParams.get(key)
            if (value) return value
        }
    } catch {
        /* url 不合法时忽略 */
    }
    return (process.env.QISHUI_DEVICE_ID || '').trim()
}

function sign(request) {
    const deviceId = deviceIdFrom(request)
    if (!deviceId) throw new Error('缺少 device_id：请在 URL/headers 里带上，或设置 QISHUI_DEVICE_ID')
    ensureInit(deviceId)

    const headerPairs = Object.entries(request.headers || {})
        .filter(([name, value]) => name && value !== undefined && value !== null)
    const headerLines = headerPairs.flatMap(([name, value]) => [`${name}\r\n${value}`]).join('\r\n')

    const raw = loadBdms().generateHttpSignatureHeaders(String(request.url || ''), headerLines) || ''
    const fields = raw.split('\r\n').filter(item => item.trim())
    const headers = {}
    for (let index = 0; index + 1 < fields.length; index += 2) {
        headers[fields[index]] = fields[index + 1]
    }
    if (!headers['X-Helios'] || !headers['X-Medusa']) {
        throw new Error(`签名不完整（收到 ${Object.keys(headers).length} 个头）`)
    }
    return { headers }
}

async function readStdin() {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8')
}

try {
    const payload = JSON.parse((await readStdin()) || '{}')
    if (!payload.url) throw new Error('url 不能为空')
    const result = sign(payload)
    process.stdout.write(JSON.stringify(result))
} catch (error) {
    process.stderr.write(String(error && error.message ? error.message : error))
    process.exit(1)
}
