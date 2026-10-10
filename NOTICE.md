# NOTICE / 致谢

本仓库包含来自以下上游项目的代码片段,感谢原作者:

| 组件 | 来源 | 上游许可 |
| --- | --- | --- |
| `qs-backend/mssdk-bridge.mjs` | [sodahub-org/libresoda](https://github.com/sodahub-org/libresoda) `tools/qishui-signer-host/`(精简改编) | AGPL-3.0-or-later |
| `qs-backend/qishui-audio-decryptor/` | [XxHuberrr/Mineradio-paused](https://github.com/XxHuberrr/Mineradio-paused) `qishui-audio-decryptor/`(原样使用) | GPL-3.0-only |
| 扫码登录流程参考 | libresoda `qr_login.rs`、Mineradio `qishui-auth-v6.js`、[Wx2yZx/Mineradio-Qishui-QR-Login](https://github.com/Wx2yZx/Mineradio-Qishui-QR-Login)(GPL-3.0-only,revision aaadaab7) | AGPL-3.0 / GPL-3.0 |

因此本仓库以 **AGPL-3.0-or-later** 发布。汽水音乐签名后端的设计思路另参考
[sodahub-org/libmssdk](https://github.com/sodahub-org/libmssdk) 的公开文档。

`bdms.node`、`metasecml.dll`、`sscronet.dll` 等字节跳动官方组件的版权归
字节跳动所有;本仓库不包含、不修改任何官方二进制,运行时需要用户自备官方客户端。
