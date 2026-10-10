# 汽水音乐逆向报告 + 签名后端实现

> 抖音系音乐 App「汽水音乐」(SodaMusic / Luna) 的完整逆向分析报告,以及一个可直接运行
> 的本地签名后端(qs-backend)——覆盖**登录、搜索、取流、下载解密、歌单、推荐**全链路。

[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2B-green)](./docs/08-implementation.md)

## 一句话结论

汽水的接口防护是**三层结构**,第三层(`X-Helios`/`X-Medusa` 应用级签名)锁死了
完整版取流,而它只能由官方客户端自带的 `bdms.node` 计算——**不要逆向它,直接加载它**:

```
免签名    → 目录数据面(搜索/歌单/推荐/歌词)     → 全量元数据
免签名    → /luna/h5/*                          → 30~60s 试听(未加密 m4a)
bdms.node → /luna/pc/*  +  X-Helios/X-Medusa    → 完整版 + CENC 密钥(SVIP 权益内)
```

## 文档目录

| 章节 | 内容 |
| --- | --- |
| [01 总览](docs/01-overview.md) | 分层安全模型、三条签名体系、最终架构 |
| [02 逆向历程](docs/02-journey.md) | 完整实验时间线:每一发子弹打在哪、看到什么、排除了什么 |
| [03 签名体系](docs/03-signature.md) | a_bogus / x-argus / x-helios 三套签名的边界与复现方式 |
| [04 登录](docs/04-login.md) | Passport 扫码、2046 二次验证、Cookie 体系、设备身份 |
| [05 取流与解密](docs/05-stream.md) | track_v2 → url_player_info → CENC/spade_a → AES-CTR |
| [06 客户端解剖](docs/06-client-internals.md) | PC 端(asar 泄漏源码/ttnet/反调试)与 Android 端 |
| [07 接口清单](docs/07-endpoints.md) | 全部已验证端点:参数、响应结构、门禁等级 |
| [08 后端实现](docs/08-implementation.md) | qs-backend 架构、部署、接口契约 |

## 源码

[`qs-backend/`](qs-backend/) —— Windows 本地签名后端(含 Node 运行时打包方案),
给任何第三方播放器当汽水音乐音源。部署与接口契约见 [08](docs/08-implementation.md)。

## 实测效果

- VIP 曲目完整版取流:**5 档音质、全时长、CENC 解密落盘**(SVIP 账号实测 4/4)
- 解密文件 mvhd 实际时长与全曲分毫不差(202s/202.1s、308s/308.2s)
- 登录:扫码 + Cookie 导入均可用;风险二次验证(2046)需官方 App 完成

## 环境要求

- Windows 10/11(签名组件只有 Windows/macOS 版)
- 本机安装**汽水音乐官方客户端**(签名要加载它自带的 `bdms.node`)
- Node.js 18+(打包版已内置 `node.exe`,免安装)

## 声明

本项目仅供**个人学习与自用**,请配合本人自己的汽水音乐账号,遵守服务条款。
禁止批量抓取、再分发音频或用于商业用途。`bdms.node`/`metasecml.dll` 等官方
组件版权归字节跳动所有,本仓库不含、也不修改任何官方二进制。
