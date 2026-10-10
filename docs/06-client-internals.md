# 06 · 客户端解剖:PC 与 Android

## 1. PC 客户端(3.7.0)

安装形态:`SodaMusicLauncher.exe` + `<版本号>/` 目录(如 `3.7.0/`,
`Packages/3.8.0` 为待升级包),Electron 定制分支 + 大量原生模块。

### 1.1 业务逻辑藏在哪

```
resources/app.asar
├── package.json   {"name":"SodaMusic","main":"./entry.js","version":"3.7.0"}
├── entry.js       98 字节: require("./entry.node").entry({exports,require,module,…})
├── main.js        98 字节: require("./main.node").entry(…)
├── entry.node / main.node      ← 全部业务逻辑(V8 snapshot,无明文可 patch)
├── entry.js.map / main.js.map  ← **金矿:646 个 TS 源文件内嵌(sourcesContent)**
├── bdms.node      ← 应用级签名生成器(本报告的核心资产)
├── bdticket.node  ← 票据签名
├── device.node    ← 设备指纹/序列
├── ttnet.node     ← 网络栈绑定
└── lmdb.node
```

> **教训与机会**:bundler 忘了从 sourcemap 里剥 `sourcesContent`,等于把主进程
> TypeScript 源码随包发布。请求层、服务层、deeplink、全局配置、反调试——全部可读。
> 而 `.node` 内嵌的 V8 snapshot 无明文字符串(grep 全无命中),二进制 patch 不可行。

### 1.2 请求层真相(来自源码)

- **JS 层不签名**:业务请求只有 Cookie + `X-SS-STUB`(body MD5)+ 三个
  `x-luna-*` 状态头;签名由 Cronet 网络栈在 native 层注入;
- 所有 HTTPS 走 `@luna/ttnet`(`protocol.handle + @luna/ttnet`),
  Electron 定制分支直接 `import { ttnet } from 'electron'`;
- `clientKeyConfig`: `{ clientKeySignEnabled: 1, updateHostList: ['api.qishui.com'], updatePathList: ['/passport/*'] }`
  ——clientKey 签名只配在 passport,业务接口的签名是 Cronet 统一行为;
- 请求入口 `RequestService.apiCaller` 还处理两个风控信号:
  响应头 `bdturing-verify`(验证码)与 `x-tt-verify-passport-decision`(二次验证),
  命中即弹窗,通过后**原请求重发**。

### 1.3 设备身份

`device.node` 注册得到 `did/iid/cdid/wdid`,持久化在
`%APPDATA%/SodaMusic/DeviceV1`;`bdms.init({deviceId})` 用同一个 did;
全局配置 `globalConfig` 同时喂给 ttnet 初始化与业务参数
(`device_id/iid/fp` 全部同源)。

### 1.4 反调试(知其边界,勿硬闯)

```ts
// beforeReady.ts
if (IS_PROD && ['inspect', 'inspect-brk', 'remote-debugging-port']
        .some(name => process.argv.some(arg => arg === `--${name}` || arg.startsWith(`--${name}=`)))) {
  … // 静默退出
}
```

- `--remote-debugging-port` / `--inspect` / `--inspect-brk` 三个 argv 被拦截;
- `NODE_OPTIONS` 被打包 fuse 禁用(实测无效);
- `mssdk/metasecml.dll` 另有标准 `IsDebuggerPresent`;
- deeplink:`luna://playing?track_id=…&media_type=track` 可外部驱动播放
  (`handlers.ts` 注册,`second-instance` 转发 argv)——但注意
  PowerShell `Start-Process -ArgumentList` 不会自动加引号,URL 里的 `&` 会截断参数。

### 1.5 客户端可观测性(无需修改)

- **无证书锁定**(api.qishui.com 实测接受 MITM CA):系统代理指向观测代理,
  全部签名请求/响应可读;
- cronet 尊重系统代理,但**本地代理必须绑 IPv4 `127.0.0.1`**
  (默认绑 `[::1]` 会让客户端卡在 SYN_SENT);
- 日志:`%APPDATA%/SodaMusic/parfait/alog/`(alog 私有格式)、`TTNet/`(空)、
  `LunaCacheV2/`(不透明 bin)——静态信息有限,动态观测才是主力。

## 2. Android 客户端(v8986)

- 包名 `com.luna.music`;`lib/arm64-v8a/libsscronet.so`(5.9MB)——同一套
  Cronet 签名栈(`x-argus/x-gorgon/x-ladon/x-khronos/x-ss-stub` 字符串全数命中),
  `libmetasec_ml.so` 为安全 SDK;
- **API 族与 PC 完全不同**(无 `/pc/`、`/h5/` 前缀):

| 接口 | 无签名(带 Cookie)实测 |
| --- | --- |
| `POST /luna/media/related` | ✅ 相关推荐 + `label_info.quality_map`(权益条件) |
| `GET /luna/playlist/detail` | ✅ 歌单全量曲目元数据(1.2MB/219 首) |
| `GET /luna/me/playlist` | ✅ 自建歌单 |
| `GET /luna/me/collection/mixed` | ✅ 收藏(106B,含状态) |
| `POST /luna/media_v2` | ❌ 空响应(与 PC track_v2 同锁) |
| `POST /luna/feed/radio/tracks` | `1000004`(参数错误——没被签名门禁拦,但参数 schema 未破解) |
| `GET /luna/feed/listen`、`/luna/feed/song` | 404(是路由名,不是 HTTP 端点) |

- dex 里可确认移动端同样消费 `main_play_url`/`spade_a`/`play_auth`——
  **取流双端同锁**,但**目录数据面移动端更开放**(qs-backend 的搜索/歌单/推荐
  数据源即来自移动端族);
- 公共参数形如:`aid=386088&app_name=luna&device_id&iid&version_code=8986&
  channel=google_play&device_platform=android&device_type=<机型>&os_version=14`;
  UA 形如 `com.luna.music/8986 (Linux; U; Android 14; …)`。

## 3. 攻击面总结(哪些路通,哪些路死)

| 路径 | 判定 |
| --- | --- |
| 纯 Cookie 打 `/luna/pc/*` | ❌ 死(应用级签名) |
| 伪造 msToken / a_bogus 打业务接口 | ❌ 死(`1000062`) |
| 浏览器 bdms.js 扩 paths 到 `/luna` | ❌ 死(签名被认出是 Web 形态 → `1000062`) |
| 提版本号 / 换 UA / 换协议 / 换域名 | ❌ 无关变量 |
| 逆向 x-helios 算法 | ❌ `bdms.node` 是 V8 snapshot,无明文 |
| **require 官方 bdms.node 当签名器** | ✅ **正路**(本仓库 qs-backend) |
| MITM + 驱动真客户端 | ⚠️ 可行但重(要代理常驻 + deeplink/UI 驱动) |
