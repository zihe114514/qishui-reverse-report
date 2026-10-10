# 04 · 登录:扫码、二次验证、Cookie 体系

## 1. 登录态的本质

汽水的登录态就是一组 Cookie,核心凭据字段:

```
sessionid_ss / sessionid / sid_guard / sid_tt   ← 会话凭据(有一个即视为已登录)
passport_csrf_token                              ← CSRF
uid_tt_ss / ssid_ucp_v1                          ← 身份与设备绑定
session_tlb_tag                                  ← 会话标签
```

`GET /luna/pc/me` 带 Cookie 返回 `status_code=0` + `my_info` 即会话有效;
返回 `status_code=1000016` 即会话失效(需要重新登录)。

`my_info` 里最有用的字段:`nickname`、`is_vip`、`vip_stage`(`"svip"` 等)、
`douyin_id`、`avatar_url`。

## 2. 登录的三条路

### 2.1 官方客户端登录 + 导出 Cookie(最简单,最稳)

1. 正常安装并登录汽水音乐 PC/网页端;
2. 从会话里取出 Cookie(浏览器 F12 → Network → 任意 `api.qishui.com` 请求 →
   复制 `Cookie` 请求头;或用专用导出工具);
3. 导入到你的实现 / 后端。

Cookie 与登录设备无强绑定(实测浏览器会话的 Cookie 配任意生成的
`device_id` 签名可用),**但会话失效需要重登**。

### 2.2 Passport 扫码(可自动化,需浏览器环境)

完整流程(需要能跑 Web 签名的环境,见 [03](03-signature.md) 第 3 节):

```
① GET /passport/web/get_qrcode/?next=https://api.qishui.com&need_logo=false&need_short_url=false
      → { data: { token, qrcode_index_url } }
② 拼官方扫码链接(关键:让手机 App 识别为 PC 登录)
      https://bff-pc.qishui.com/light/invoke/scan_login?token=<token>&os=Windows&computer_name=<主机名>
③ 用任意二维码库把这个 URL 渲染成码,汽水音乐 App 扫码
④ POST /passport/web/check_qrconnect/ (form: token,is_frontier=true,is_new_login=1,next=…)
      轮询:data.status = "new" → "scanned" → "3"(confirmed)
⑤ 200/2046 二次验证 → ⑥ 成功 → ⑦ 收割 Cookie
```

**公共参数**(每条 passport 请求的 query 都要带):

```
passport_jssdk_version=2.4.13  p_js_v=2.4.13  p_js_t=pro
p_zt=3.3.5  p_ver=1.0.29  p_bd=1.0.0.41
aid=386088  language=zh  account_sdk_source=web
device_id=<16位>  install_id=<15位>  did=  iid=
device_platform=PC  version_code=3.5.2
account_sdk_source_info=<页面指纹加密串>  msToken=<118字符>  is_new_login=1
```

外加请求头 `x-tt-passport-verify-portrait`(`<uuid>.login`)与 trace 头。

**设备身份**:`deviceId`(16 位)、`installId`(15 位)、`verifyPortraitId`
(UUID + `.login`)首启随机生成、持久化即可,实测无需服务端注册。

### 2.3 扫码 + 二次验证(2046)——风控的看门狗

`check_qrconnect` 扫码确认后可能返回:

```json
{ "data": { "error_code": 2046, "verify_url": "…", "biz_params": "…" } }
```

含义:风控要求二次验证。纯 API 无法闭环——需要把官方验证组件
(`verify_url` 指向的脚本,内部走 verify.zijieapi.com)在真实浏览器环境里
渲染出来,人过完滑块/手机确认后,组件回调 `verifyFinishCallback`,
再带 `biz_params` 重发 `check_qrconnect`(POST body 加 `is_resend=true`)。

实测:验证 UI 必须可见(用户操作),同窗口内嵌组件即可;验证结果
`{"status": true}` 后重发即确认成功。

## 3. Cookie 持久化与失效处理

- 存储:明文 JSON/TXT 均可(注意这是账号凭据,别进版本库);
- **失效信号**:
  - 业务响应 `status_code === 1000016` → 会话失效,清除本地凭据;
  - HTTP 401/403 → 同上;
  - 二次验证频繁出现 → 会话被风控盯上,建议重登;
- **失效后不要反复重试**:参考实现的惯例是 401/403 立即停手,连打只会让
  风控更快处理这个会话。

## 4. Cookie 与签名的关系

- Cookie 参与**应用级签名**(桥接器的 headers 里带 Cookie,签名覆盖它);
  所以换 Cookie 后,旧签名全部作废——签名是逐请求现算的,天然没问题;
- Cookie 与 `device_id` 无强绑定:浏览器会话的 Cookie 配随机生成的
  `deviceId` 签名,实测可用;
- 但**不要频繁换 device_id**:同一 Cookie 稳定用一个 did,风控更友好。
