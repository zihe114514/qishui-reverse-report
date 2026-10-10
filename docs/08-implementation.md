# 08 · qs-backend:实现与部署

## 1. 定位

一个 ~350 行的本地 Node 服务,把「汽水音乐签名 + 协议」封装成 HTTP 接口,
给任何第三方播放器当音源。**客户端二进制零修改**,签名直接由官方客户端自带的
`bdms.node` 完成。

```
qs-backend/
├── server.mjs                     主服务(数据面 + 签名代理 + 取流解密管线)
├── mssdk-bridge.mjs               签名桥接器(stdin/stdout 契约,spawn 模型)
├── qishui-audio-decryptor/        CENC/spade_a 解密器
│   ├── track-decryptor.js
│   ├── decrypt-utils.js
│   └── mp4-box.js
├── node.exe                       (打包版内置的官方 Node v22 运行时)
├── start.bat                      双击启动
├── config.json                    首启自动生成:cookie/device_id/client_dir/port
├── cache/                         解密后的音频缓存(track_id sha1 前缀命名)
└── README.txt
```

## 2. 配置(config.json,首启自动生成)

```jsonc
{
  "version": 1,
  "port": 8787,
  "device_id": "6949684974427707",   // 首启随机生成,持久化,勿共享
  "client_dir": "D:\\Soda Music\\3.7.0",  // 自动探测:注册表 → LOCALAPPDATA → 盘符扫描
  "cookie": "…sessionid_ss=…"         // 游戏内登录后模组自动推送,或手动 POST /api/cookie
}
```

探测顺序:环境变量 `QISHUI_CLIENT_DIR` → 注册表 Uninstall 的 `InstallLocation`
→ `%LOCALAPPDATA%/Programs/Soda Music/<最新版本>` → 各盘符 `\Soda Music\<版本>`。
判据:目录下存在 `resources/app.asar.unpacked/bdms.node`。

## 3. 签名桥接(mssdk-bridge.mjs)

一次一签,spawn 模型(每次请求拉起 `node mssdk-bridge.mjs`,加载 bdms.node、
签名、退出;开销约 100ms,个人使用无感,要吞吐可改常驻进程池):

```js
// 官方调用面(与客户端 src/app.ts 一致):
bdms.init({ deviceId })
generateHttpSignatureHeaders(url, headerLines)   // headerLines = "名字\r\n值\r\n…"
```

环境变量:`QISHUI_CLIENT_DIR`(客户端目录)、`QISHUI_DEVICE_ID`(设备身份)、
`QISHUI_BDMS_PATH`(直接指定 bdms.node)。

## 4. 接口契约

| 端点 | 方法 | 入参 | 出参 |
| --- | --- | --- | --- |
| `/api/health` | GET | — | `{ok, device_id, bdms, client_dir, has_cookie, cache_files}` |
| `/api/cookie` | GET/POST | POST: `{"cookie":"…"}` | Cookie 状态 / 导入(校验登录凭据字段) |
| `/api/search?q=&limit=` | GET | 关键词 | `{songs:[{id,name,duration_ms,artists,album,vip,audition}]}` |
| `/api/playlist/:id` | GET | 歌单 id | `{id,name,track_count,tracks[]}` |
| `/api/related/:trackId` | GET | 曲目 id | `{related[]}` |
| `/api/pc` | POST | `{path:"/luna/pc/…",params:{},body:{}}` | `{http_status, body:<汽水原始响应>}`(白名单仅 `/luna/pc/*`) |
| `/api/stream/:trackId` | GET | 曲目 id | `{status,file_url,name,artist,duration_ms,bitrate_kbps,encrypted,qualities[]}` |
| `/api/file/:name` | GET | 缓存文件名 | 音频流(支持 Range) |

全部响应带 CORS(`Access-Control-Allow-Origin: *`),只监听 `127.0.0.1`。

## 5. 取流管线(server.mjs `streamTrack`)

1. 缓存命中(sha1(track_id) 前缀)→ 直接回 `file_url`;
2. 签名 `track_v2`(POST + `X-SS-STUB` + 桥接签名)→ `track_player.url_player_info`;
3. GET `url_player_info` → `PlayInfoList` → 按码率选最高档;
4. 下载 `MainPlayUrl` 密文;
5. `TrackDecryptor.decrypt({encryptedBuffer, spadeA: PlayAuth})`;
6. 落盘 `cache/<hash>__<曲名 - 歌手>.m4a` + 写 `<hash>.meta.json`;
7. 回 `{status:'ok', file_url:'/api/file/…', …meta}`。

## 6. 部署

### 6.1 手动(开发)

```powershell
# 需要 Node 18+ 与本机汽水音乐客户端
node server.mjs
# 或指定配置
$env:QISHUI_CLIENT_DIR='D:\Soda Music\3.7.0'; node server.mjs
```

### 6.2 伴生包(推荐,免装 Node)

打包产物 `qishui-backend-windows-x64-1.0.0.zip`(33,184,408 字节,
sha256 `bcc8cfeb…6f44`)内置官方 `node.exe`,解压即用:

```powershell
Expand-Archive qishui-backend-windows-x64-1.0.0.zip -DestinationPath C:\tools\
C:\tools\qishui-backend\start.bat
```

托管在 [`MuoniumPlayer-updates` 仓库 `qishui-companion/`](https://github.com/zihe114514/MuoniumPlayer-updates/tree/main/qishui-companion),
MuoniumPlayer 模组在检测到本机后端缺失时按 Skija 伴生包先例自动
下载(五条镜像链)→ 校验 → 解压 → 拉起 → Cookie 配对。

### 6.3 开机自启(可选)

```powershell
schtasks /create /tn QishuiBackend /sc onlogon /tr "C:\tools\qishui-backend\start.bat"
```

## 7. 给模组/播放器作者的接入建议

1. **探测**:`GET /api/health`,`ok:true` 即可用;缓存探测结果 30s;
2. **配对**:自己有汽水 Cookie 就在探测到 `has_cookie:false` 时 POST 过去;
3. **取流**:`GET /api/stream/:trackId` → 拿 `file_url` 交给播放内核(Range 已支持);
4. **降级**:后端不可用时回落到免签名路径(移动端族搜索/歌单 + h5 试听),
   并把降级状态明确告知用户——绝不静默假装成功;
5. **别拼签名**:所有 `/luna/pc/*` 需求都走 `/api/pc`,签名和头序由后端统一负责。

## 8. 已知边界

- Hi-Res/杜比/无损档需要对应 SVIP 权益,服务端按权益下发,后端只选"最高可用档";
- `msToken` 体系未接入(实测对取流非必需;带陌生值反而 `1000062`);
- 风控二次验证(2046)只在登录环节出现,取流链路未观测到;
- 长期高频调用可能触发风控——个人播放器节奏下(秒级间隔)未观测到问题。
