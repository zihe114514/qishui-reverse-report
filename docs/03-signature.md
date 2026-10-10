# 03 · 签名体系:三套签名、两个例外、一条正路

## 1. 全景

| # | 签名 | 生成位置 | 保护的接口 | 算法可复现? |
| --- | --- | --- | --- | --- |
| 1 | `a_bogus`(44 字符)+ `msToken`(118 字符 base64) | 浏览器里的 `bdms.js`(Web 安全 SDK) | `/passport/web/*`(扫码登录)、`/ttwid/` | ✅ 无头浏览器加载官方 SDK 即可,无需懂算法 |
| 2 | `X-Helios` + `X-Medusa` | **原生 `bdms.node`**(客户端自带,Node NAPI) | `/luna/pc/*` 全族(取流/账号歌单/写操作) | ✅ **直接 require 官方模块** |
| 3 | `x-argus`/`x-gorgon`/`x-khronos`/`x-ladon`/`x-ss-req-ticket` | Cronet 网络栈(`sscronet.dll`/`libsscronet.so`) | 官方客户端的每个请求(native 注入层) | ❌ 不可复现,也无需复现 |

三套签名的**宿主不同、覆盖接口不同、校验强度不同**,混着理解必然碰壁。
_qs-backend 只用 2(以及借官方客户端间接持有 3 的能力);扫码登录只用 1。

## 2. 应用级签名(X-Helios / X-Medusa)——核心

### 2.1 官方调用方式(sourcemap 泄漏的 `src/app.ts`)

```ts
bdms.init({ deviceId: deviceData.did ?? fakeDid })

// 每个发往 qishui.com 的请求(/passport/、/ttwid/ 除外):
headers['user-agent'] = [`LunaPC/${APP_VERSION}(${TRON_BUILD_ID})`]
const headerLines = /* 把 headers 展平成 "名字\r\n值\r\n名字\r\n值…" */
const signatureData = bdms
  .generateHttpSignatureHeaders(params.url, headerLines.join('\r\n'))
  .split('\r\n').filter(t => t.trim())
for (let i = 0; i < signatureData.length / 2; i++)
  headers[signatureData[i * 2]] = [signatureData[i * 2 + 1]]
```

### 2.2 复现要点(每一条都踩过)

1. **签名覆盖 URL + 将要发送的每一个请求头**。`Cookie`、`X-SS-STUB`(body 的
   MD5 大写)、`x-luna-*` 全部参与——桥接器必须看到"即将发送的头",且发出去的
   一个字节都不能差;
2. **`deviceId` 必须与 `bdms.init` 一致**,并写进请求参数(`device_id/iid/fp`)。
   16 位数字,首启生成后持久化即可(实测无需服务端注册);
3. **POST 必带 `X-SS-STUB`**:body 变了签名就废——签名和 body 是一起算的;
4. 生成头名是 `X-Helios`/`X-Medusa`,原样写回请求;
5. `bdms.node` 只在 Windows/macOS 客户端里发布。Linux/其他平台用
   `QISHUI_SIGNER_URL` 远程签名服务形态(libresoda 的 topology)。

### 2.3 桥接器契约

```
stdin : {"url":"https://api.qishui.com/luna/pc/track_v2?…",
         "method":"POST",
         "body":"{\"track_id\":\"…\"}",
         "headers":{"User-Agent":"LunaPC/3.7.0(…)","Content-Type":"…",
                    "X-SS-STUB":"8DF5…","Cookie":"…","x-luna-*":"…"},
         "ts_ms":1789435000000}
stdout: {"headers":{"X-Helios":"…","X-Medusa":"…"}}
```

`X-Medusa` 是长 base64(约 1KB),`X-Helios` 是短 token(约 50 字符),
两者都随每次请求变化。

## 3. Web 签名(a_bogus / msToken)——只管登录

### 3.1 机制

字节安全 SDK 的 Web 版(`bdms.js` v1.0.0.41)+ 官方胶水(`sdk-glue.js`)在浏览器
页面里钩住 XHR:凡 URL 命中 `paths` 配置前缀的请求,自动追加 `a_bogus` 与 `msToken`。

### 3.2 官方姿势(与 Mineradio auth-v6 一致)

1. 隐藏浏览器窗口 + 独立 session partition;
2. 本地 127.0.0.1 资产服务器 serve 宿主页,把官方 CDN 的 `bdms.js` 重定向到本地副本;
3. `_SdkGlueInit({ self: { aid: 386088, pageId: 24554 }, bdms: { aid: 386088, paths: ['/passport'] } })`
   ——**注意 `paths` 只配了 `/passport`**:Web 签名的法定辖区是登录,别扩到业务接口;
4. `msToken` 首启生成随机 118 字符 base64(`…==`)存 `localStorage('xmst')`;
5. 业务参数:`passport_jssdk_version=2.4.13`、`p_bd=1.0.0.41`、`p_zt=3.3.5`、
   `p_ver=1.0.29`、`account_sdk_source_info`(页面 `__browserInfo` 加密指纹)等。

### 3.3 边界(实测)

- `/passport/web/get_qrcode`、`check_qrconnect` 用随机 `msToken` 即可通过
  (登录校验宽松);
- **业务接口带陌生 `msToken` 反而触发 `1000062`**——`msToken` 不是万能通行证,
  是"服务端认识的才放行,不认识的直接拒";
- `error_code 2046` = 风控二次验证,需官方验证组件(verify.zijieapi.com)在
  真实浏览器环境完成,纯 API 不可闭环。

## 4. Native 网络栈签名——知道它存在就够了

`sscronet.dll`(PC)/ `libsscronet.so`(Android)是字节魔改的 Cronet,在 socket
之上、应用之下给每个请求注入 `x-argus/x-gorgon/x-ladon/x-khronos/x-ss-req-ticket`。
它解释了"官方客户端 JS 层为什么看不见签名",也解释了"为什么抓包看到一堆你构造
不出的头"。**正解不是复刻它,而是认识到服务端对第三方放行的是应用级签名那一层。**

## 5. 决策树

```
要调什么?
├─ /passport/web/*(扫码登录)      → 浏览器 + bdms.js(a_bogus),接受 2046 需官方验证
├─ /luna/search、/luna/me/* 等
│   目录数据面                     → 什么都不用,Cookie(甚至匿名)
├─ /luna/h5/*(试听/歌词)          → 什么都不用;别带陌生 msToken!
└─ /luna/pc/*(完整版/账号写操作)  → bdms.node 桥接(X-Helios/X-Medusa)
```
