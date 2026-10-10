# 02 · 逆向历程:完整实验时间线

> 记录每一步真实做过的实验:输入、观测、推断、排除。后人不必重走弯路。

## 阶段 0:站在前人肩膀上

**起点:Mineradio(GPL-3.0,已停更的 Electron 播放器)**。它的汽水接入由四部分组成:

| 模块 | 做法 | 2026 年现状 |
| --- | --- | --- |
| `qishui-auth-v6.js` 登录 | 隐藏 Electron 窗口 + 本地资产服务器,加载官方 `bdms.js` Web SDK 给 passport 请求注签 | ✅ 仍可用(2046 二次验证也处理了) |
| `qishui-api.js` 业务 | 纯 Node 直发 `/luna/pc/*`,**无应用级签名** | ❌ 全族空响应 |
| `qishui-audio-decryptor/` | CENC/MP4 解析 + spade_a → AES-128-CTR | ✅ 仍可用 |
| 音频代理 | `#auth=spade_a` 挂 URL 尾部传密钥 | ✅ 思路仍可用 |

它 2025 年初能跑,是因为**当时 `/luna/pc/*` 还没上应用级签名**。停更后服务端收紧,
纯 Cookie + 无签名的路整体死亡——这是后面所有实验的原点。

## 阶段 1:确认「签名只在登录」是错的

**实验**:用真实 Cookie(浏览器登录的 SVIP 账号)直发业务接口。

- `GET /luna/pc/me`(无签名)→ `200, status_code=0`,昵称、`is_vip: true`、
  `vip_stage: "svip"` 全量返回 ✅
- `POST /luna/pc/track_v2`(无签名)→ `200, len=0` **空 body** ❌
- `GET /luna/pc/search/track`(无签名)→ `200, len=0` ❌

**推断**:门禁是**端点级**的。空响应来自源站(`x-dsa-origin-status: 200`,
`server-timing: inner; dur=23`),不是 CDN 或网络问题。

## 阶段 2:排除法大战(全部失败的尝试)

对 `track_v2` 逐一排除变量,**每次只动一个**:

| 变量 | 实验 | 结果 |
| --- | --- | --- |
| Accept-Encoding | `identity` 显式声明 | 空 |
| HTTP 客户端 | undici fetch → 裸 `https.request` | 空 |
| 域名 | `api5-lq.qishui.com` 备用 | 空 |
| 协议 | HTTP/2(`http2.connect`) | 空 |
| 版本号 | 3.3.0 → 3.5.2 → 3.9.0 → 4.0.0 → 4.3.0 → 5.0.0 | 空 |
| 请求头 | `X-SS-STUB`(body MD5)、`x-luna-*`、Referer | 空 |
| 设备一致性 | 稳定 `device_id/iid/fp`(模拟持久化) | 空 |
| os_version | `Windows 11` → 真实 `10.0.26200` | 空 |
| `msToken` | 随机 118 字符 | **`1000062`**(比空更糟) |
| PC→H5 | `/luna/h5/track_v2` | ✅ **返回数据!但只有试听** |

**两个转折点**:

1. `feed/song-tab` 直接 **404 Not Found**——端点被下线了,证实服务端 API 面
   在 Mineradio 停更后已经演化;
2. `/luna/me/recently-played-media` 却能返回 26KB——**免签名数据面存在**,
   门禁不是一刀切。

## 阶段 3:H5 试听面的精确刻画

用 `/luna/h5/track_v2`(纯 Cookie 可用)批量抽测 30 首 VIP 歌:

- 30/30 返回流,但 **30/30 都是试听段**(29~60 秒,未加密 m4a,66k/130k);
- 试听时长与响应里 `audition_info` 声明的区间**精确吻合**(One Last Kiss 30s、因为爱情 56.7s);
- 试听 URL 直连可用:无 Referer/签名,Range 请求 206,文件头 `ftypM4A`;
- 对照实验:随机 `msToken` 参数 → `1000062`;`fp/device_id` 变体 → 仍试听。

**结论**:`1000062` = "msToken 无效";无 msToken = 降级试听。SVIP Cookie 不改变
试听命运——**签名等级本身就是权益维度**。

## 阶段 4:解剖真客户端(PC 3.7.0)

安装目录 `D:\Soda Music\3.7.0`:

1. `resources/app.asar` 里的 JS 只有 **98 字节**(`require("./entry.node").entry(...)`)
   ——业务逻辑全在 native 模块里;
2. **金矿:main.js.map / entry.js.map 内嵌 646 个 TypeScript 源文件**(bundler 忘了删
   sourcesContent),完整的请求层源码直接读:
   - `request.ts`:JS 层只加 Cookie + `X-SS-STUB`(注释明说是"TTNet rs.29 需要的 body 摘要头");
   - `ttnet.ts`:所有 HTTPS 走 `@luna/ttnet`(Cronet 绑定);`clientKeySignEnabled` 只配在 `/passport/*`;
   - `afterReady.ts`:`bdms.init({deviceId})`——安全 SDK 与设备身份同源;
   - `beforeReady.ts`:反调试就是三行——`IS_PROD && ['inspect','inspect-brk','remote-debugging-port'].some(argv 命中) → 退出`;
3. `sscronet.dll` 字符串扫描:`x-argus/x-gorgon/x-khronos/x-ladon/x-ss-req-ticket` 全套——
   native 网络栈给每个请求注入签名,JS 无感;
4. 反调试实测:`--remote-debugging-port`、`--inspect` 均静默退出(NODE_OPTIONS 被打包
   fuse 禁用)。

**结论:JS 层零签名逻辑可抄;签名在 native;而 native 的 `bdms.node` 就躺在安装目录里。**

## 阶段 5:Android APK 交叉验证(v8986)

- `libsscronet.so`:同样的全套签名头字符串——移动端同一套 native 体系;
- 移动端 API 族不同(无 `/pc/`、`/h5/` 前缀):`/luna/media/related`、
  `/luna/media_v2`、`/luna/feed/*`、`/luna/playlist/detail`;
- 实测:`/luna/media/related`、`/luna/playlist/detail`(1.2MB 全量歌单元数据)、
  `/luna/me/playlist` **免签名可用**;`/luna/media_v2`(移动端取流)同样空响应。

**结论:取流端点在双端都被同一套 native 签名锁死,没有薄弱端。但免签名的目录
数据面比 PC 端丰富**(移动端族后来成为 qs-backend 搜索/歌单/推荐的数据源)。

## 阶段 6:MITM 与官方客户端驱动(最终方案前的迂回)

- 装观测代理 CA → 系统代理 → 启动官方客户端:**api.qishui.com 无证书锁定**,
  客户端签名请求全量可观测;
- 客户端支持 `luna://playing?track_id=xxx` deeplink,可外部驱动播放;
- 冷启动链路:deeplink → 客户端自动扫码登录流程 → 2046 二次验证(官方组件 UI)
  → 捕获带完整签名的 `track_v2` 响应(27KB)→ `url_player_info` →
  **5 档全时长 CENC 流 + spade_a** → 解密 `恶作剧 - 林依晨.m4a`(8.76MB)成功。

这条链路成立,但要驱动 UI、常驻代理,重。**最终答案在下一步。**

## 阶段 7:libresoda 点破窗户纸

GitHub 上发现 [`sodahub-org/libresoda`](https://github.com/sodahub-org/libresoda)
(AGPL-3.0,Rust),把整个谜底写在了文档里:

> `/luna/pc/track_v2` 要求逐请求的应用级签名头 `x-helios`/`x-medusa`
> (由官方 mssdk/metasecml.dll 生成),签名对 URL+body 字节敏感;
> 无签名 200 空体、只有试听——**解决:签名抽成独立服务,Windows 上跑 libmssdk**。

其 `tools/qishui-signer-host/mssdk-bridge.mjs` 给出落地实现:**不逆向 metasecml.dll**,
直接 `require` 官方客户端的 `bdms.node`:

```
bdms.init({ deviceId })
generateHttpSignatureHeaders(url, headerLines) → "X-Helios\r\n…\r\nX-Medusa\r\n…"
```

实测:桥接器一次调用,真签名到手;带签名的 `track_v2` → 因为爱情 5 档全时长 →
解密 202.1s 完整版。**全链路闭合。**

## 阶段 8:工程化(qs-backend)

- 签名桥接器 spawn 模型、PC 白名单代理、免签名数据面(移动端族)、取流解密管线、
  自包含 config.json、设备身份持久化、Cookie 推送端点;
- 打包 33MB zip(含官方 Node 运行时),干净目录冒烟通过;
- 上传 MuoniumPlayer-updates 仓库作伴生包,模组侧按 Skija 伴生包先例实现
  自动下载/校验/解压/拉起/Cookie 配对;
- VIP 曲目回归:因为爱情 202.1s、蜗牛 308.2s、One Last Kiss 252s、
  You(feat. Wiley) 202s——**4/4 完整版,mvhd 实际时长精确吻合**。

## 失败清单(防重蹈)

| 尝试 | 下场 |
| --- | --- |
| 伪造/随机 `msToken` | `1000062`,比不带更糟 |
| 直接逆向 `x-helios` 算法 | `bdms.node` 无明文字符串(V8 snapshot),放弃即正确 |
| `--inspect`/CDP 驱动真客户端 | argv 反调试三行拦截 + NODE_OPTIONS 被 fuse 禁用 |
| 补丁 main.node 内嵌 bundle | V8 snapshot,无明文可 patch |
| 指望移动端薄弱 | `media_v2` 同样空响应,双端同锁 |
| 无限提升 `version_code` | 无关变量,3.3.0→5.0.0 全空 |
