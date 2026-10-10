# 01 · 总览:分层安全模型

> 结论先行。所有论断均经真实请求验证,实验过程见 [02 逆向历程](02-journey.md)。

## 1. 汽水音乐的三个世界

汽水音乐(包名 `com.luna.music`,PC 进程 `SodaMusic.exe`,应用 `aid=386088`,
`app_name=luna_pc`)的接口按**签名等级**分成三个世界:

| 世界 | 接口族 | 签名要求 | 能拿到什么 |
| --- | --- | --- | --- |
| **目录数据面** | `/luna/search/track`、`/luna/media/related`、`/luna/playlist/detail`、`/luna/me/*` | 仅 Cookie(甚至匿名) | 全量元数据:曲目、歌单、歌手、权益标记、歌词 |
| **试听面** | `/luna/h5/track_v2`、`/luna/h5/seo_track` | 无签名即响应 | 30~60 秒**未加密** m4a 试听段 + 全曲歌词 |
| **完整版权益面** | `/luna/pc/track_v2` 等 `/luna/pc/*` | Cookie + `X-Helios` + `X-Medusa` | 全档音质完整版,CENC 加密流 + `spade_a` 解密密钥 |

三条硬事实(全部实测复现):

1. `/luna/pc/*` 无签名 → HTTP 200 + **空 body**(源站有意为之,
   响应头 `x-dsa-origin-status: 200` 可证);
2. `/luna/h5/*` 无签名 → 试听段;**多带一个服务端不认识的 `msToken` → `1000062`**(比不带更糟);
3. `X-Helios`/`X-Medusa` 由官方客户端自带的原生模块 `bdms.node` 的
   `generateHttpSignatureHeaders(url, headerLines)` 生成,**逐请求与 URL + 全部请求头字节级绑定**。

## 2. 三套签名体系,别混在一起

| 体系 | 生成方 | 覆盖接口 | 复现方式 |
| --- | --- | --- | --- |
| **Web 签名**(`a_bogus` + `msToken`) | 浏览器版 bdms.js(字节安全 SDK Web 版) | `/passport/web/*`(扫码登录)、部分 Web 端点 | 在无头浏览器里加载官方 `bdms.js` + `sdk-glue`(`_SdkGlueInit({bdms:{paths:['/passport']}})`),让 SDK 钩住 XHR 注入 |
| **应用级签名**(`X-Helios` + `X-Medusa`) | **原生** `bdms.node`(Node NAPI 模块,客户端自带) | `/luna/pc/*` 全族 | **直接 `require` 官方 `bdms.node`**(无需逆向),`init({deviceId})` + `generateHttpSignatureHeaders` |
| **Native 网络栈签名**(`x-argus`/`x-gorgon`/`x-ladon`/`x-khronos`) | 魔改 Cronet(`sscronet.dll` / Android `libsscronet.so`) | 官方客户端的每一个请求(注入层,与上面正交) | **不可复现**——但也不需要:走 `bdms.node` 应用级签名即可通过门禁 |

关键认知:官方客户端的 JS 层**看不到任何签名**(全部由 native 网络栈在底层注入),
但服务端真正校验的是应用级签名那一层——而那一层的生成器 `bdms.node` 是官方客户端
明晃晃带在安装目录里的。**这就是整场逆向的落脚点:与其复刻签名,不如借用签名器。**

## 3. 最终架构(qs-backend)

```
第三方播放器(Java/Kotlin/JS/任何语言)
      ↓ HTTP 127.0.0.1:8787
qs-backend(本地 Node 服务)
      ├─ 免签名数据面:直接转发 Cookie 请求(搜索/歌单/推荐)
      ├─ 签名代理 /api/pc:白名单(/luna/pc/*)→ 拼 URL → 签名 → 带 Cookie 转发
      │       ↓ spawn
      │   mssdk-bridge.mjs
      │       ↓ require
      │   bdms.node(官方客户端 resources/app.asar.unpacked/bdms.node,原样加载)
      │       ↓ X-Helios + X-Medusa(覆盖 URL + 全部请求头)
      ├─ 取流:track_v2 → url_player_info → 下载 CENC 密文
      └─ 解密:spade_a → AES-128-CTR 逐 sample → 完整 m4a/flac 落盘
```

设计要点:

- **客户端二进制零修改**。`bdms.node` 原样 `require`,不逆向、不 patch,版权干净;
- **签名必须由最终发请求的一方完成**:签名与请求头字节绑定(`X-SS-STUB` 是 body 的
  MD5 大写,Cookie 也在签名覆盖范围内),模组签完再自发必然失效;
- **设备身份(`device_id`)一致性**:16 位数字,`bdms.init({deviceId})` 与请求参数里的
  `device_id/iid/fp` 必须同源,首启生成后持久化。

## 4. 权益模型

服务端按「签名等级 × 账号权益」双因子决定下发内容:

| 账号 \ 请求 | 无签名 | 应用级签名 |
| --- | --- | --- |
| 未登录 | 试听(部分曲目) | — |
| 免费 | 试听 | 完整版(免费曲)+ 标准音质 |
| VIP | 试听(**与无权益无异**) | 完整版 + 320k/无损 |
| SVIP | 试听 | 完整版 + Hi-Res/杜比/无损 |

实测要点:**无签名请求带 SVIP Cookie 也只拿试听**——签名等级本身就是一个权益
维度,登录态解决的是"你是谁",签名解决的是"你是不是官方客户端"。

## 5. 合规边界

- 只动自己的账号、只下自己权益内的内容;
- 官方组件(`bdms.node`/`metasecml.dll`)原样加载、零修改;
- 后端只监听 `127.0.0.1`;
- 不批量、不分发音频(见仓库根 README 声明)。
