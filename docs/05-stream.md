# 05 · 取流与解密:从 track_id 到完整版音频

## 1. 全链路

```
track_id
  ↓  POST /luna/pc/track_v2 (Cookie + X-Helios/X-Medusa 签名)
track 元数据 + track_player.url_player_info (AWS 预签名 VOD 地址)
  ↓  GET url_player_info (免签名,直接请求)
Result.Data.PlayInfoList[]  —— 每档音质: MainPlayUrl + PlayAuth(spade_a) + EncryptionMethod
  ↓  GET MainPlayUrl (免签名,直接下载)
CENC 加密密文 (m4a 容器: moov 明文 + mdat 密文)
  ↓  spade_a → AES-128-CTR 逐 sample 解密
完整版 m4a / flac
```

**只有第一步需要签名**,后面两跳都是免签名的(地址本身已预签名/直链)。

## 2. track_v2 详解

### 2.1 请求

```
POST https://api.qishui.com/luna/pc/track_v2?<PC 公共参数>
Content-Type: application/json; charset=utf-8
Cookie: <SVIP cookie>
X-SS-STUB: <body 的 MD5 大写>
x-luna-background-type: foreground
x-luna-is-background-req: 0
x-luna-is-local-user: 1
X-Helios: <bdms 签名>
X-Medusa: <bdms 签名>

{"track_id":"6934588485374314497","media_type":"track",
 "queue_type":"favorite_track_playlist","scene_name":"library"}
```

POST 失败可降级 GET(`?track_id=…&media_type=track`),签名重算。
备用域名 `api5-lq.qishui.com`。

PC 公共参数(每个都要参与签名,`device_id/iid/fp` 必须与 `bdms.init` 同源):

```
aid=386088  app_name=luna_pc  region=cn  geo_region=cn  os_region=cn
device_id=<16位>  iid=<did>  fp=<did>  cdid=
version_name=3.7.0  version_code=30070000  channel=official  build_mode=master
device_platform=windows  device_type=Windows  os_version=10.0.26200
ac=wifi  tz_name=Asia/Shanghai
```

### 2.2 响应结构(SVIP 账号实测)

```jsonc
{
  "status_info": { "log_id": "…", "now": 1791656000 },
  "lyric":       { "content": "[20840,1980]<0,210,210>歌词逐字时间轴…" },
  "track": {
    "id": "6934588485374314497", "name": "One Last Kiss",
    "duration": 252027, "vid": "v10ad6g50000…",
    "label_info": {
      "only_vip_playable": true,
      "quality_only_vip_can_play": ["lossless"],
      "quality_map": { "lossless": { "play_detail": { "condition": "benefit…" } }, … }
    },
    "audition_info": { "vid": "…", "start_time_ms": 97536, "duration_ms": 30001 },
    "bit_rates": [ { "br": 66132, "quality": "medium" }, … ]
  },
  "track_player": {
    "url_player_info": "https://vod-luna.douyin.com/?Action=GetPlayInfo&…X-Amz-Algorithm=AWS4-HMAC-SHA256&…",
    "video_model": "{\"status\":10,…}", "video_model_type": "…",
    "expire_at": …
  },
  "risk_result": 0
}
```

要点:

- `lyric.content` 就是**逐字歌词**(`[字内偏移,时长]<行起点,行时长,字时长>文本`),
  转 LRC/QRC 即可上歌词页;
- `label_info.quality_map` 描述每档音质的权益条件——**不绕它,它就是你账号能听什么的标准答案**;
- `audition_info` 存在说明有试听段,但 SVIP 权益内拿到的流是完整版(见下)。

## 3. url_player_info:二跳取流清单

`url_player_info` 是字节 VOD 服务的 AWS4-HMAC-SHA256 预签名地址,**免签名直接 GET**:

```jsonc
{ "Result": { "Data": { "PlayInfoList": [
  { "Format": "m4a", "Bitrate": 324234, "Duration": 226.673, "Size": 9186905,
    "EncryptionMethod": "cenc-aes-ctr",
    "PlayAuth": "<spade_a 密钥,52 字符 base64>",
    "MainPlayUrl": "https://v26-luna.douyinvod.com/…", "BackupPlayUrl": "…",
    "UrlExpire": 1791655995, "FileHash": "…" },
  … 5 档:324k / 320k / 260k / 132k / 68k
] } } }
```

- **权益内**:每档 `Duration` = 全曲时长,`EncryptionMethod = "cenc-aes-ctr"`,
  `PlayAuth` 非空;
- **权益外/无签名**:只给一条 30~60s 的试听,`EncryptionMethod` 为空、
  `PlayAuth` 为空(试听本身不加密);
- 试听/完整的判定:流时长 + 5s < 全曲时长 → 试听。

## 4. 解密:CENC + spade_a

### 4.1 密文形态

MP4 容器,`moov` 明文(包含 `senc` 盒:每 sample 一个 8 字节 IV,补零成 16 字节;
`enca` 盒标记加密音频轨),`mdat` 是密文。FLAC 曲目是 **flac-in-mp4**(`dfLa` 盒)。

### 4.2 密钥:spade_a → 16 字节 AES key

`PlayAuth` 就是 Mineradio 代码里的 `spade_a`,自定义混淆编码:

```text
base64 解码 → 字节流 b
padding = (b[0] ^ b[1] ^ b[2]) - 48
inner   = b[1 : len-padding-1]
逐字节: out[i] = (inner[i] ^ inner[i-1](首字节用 0xfa,0x55 前缀)) - bitCount(i) - 21
再按 base36 跳过头部若干字节,得到 hex 字符串 → 16 字节 AES-128 key
```

(完整实现见仓库 `qs-backend/qishui-audio-decryptor/decrypt-utils.js` 的
`decryptSpadeA`,与模组 Java 版 `QishuiAudioDecryptor.resolveKey`。)

### 4.3 逐 sample 解密

```
解析 moov→trak→mdia→minf→stbl: stsz(每 sample 大小) stsc stco(schunk 偏移)
解析 senc: 每 sample 的 IV(8 字节左对齐补零成 16)
从 mdat 数据区起,按 stsz 逐 sample:
    plaintext = AES-128-CTR(key, iv, ciphertext_sample)
FLAC 输出: "fLaC" 魔数 + dfLa 元数据 + 所有明文 sample 顺序拼接
M4A  输出: 原容器就地回写明文,并把 enca 盒名改成 mp4a(播放器才认)
```

健壮性提醒(libresoda 踩过):MP4 盒长度的 32 位字段必须设上限校验,
否则畸形头部会引发巨量预分配 OOM。

## 5. 实测数据(SVIP 账号)

| 曲目 | 全曲 | 解密文件实际时长(mvhd) | 码率 | 大小 |
| --- | --- | --- | --- | --- |
| 因为爱情(周杰伦/那英) | 202s | **202.1s** | 324k | 7.81MB |
| 蜗牛(动力火车等) | 308s | **308.2s** | 324k | 11.91MB |
| One Last Kiss(宇多田ヒカル) | 252s | 252s | 324k | 9.74MB |
| You (feat. Wiley)(Ed Sheeran) | 202s | 202s | 324k | 7.79MB |

试听段对照:30~60s、66k/130k、`EncryptionMethod=""`、无密钥、1~2MB。

## 6. 下载

`MainPlayUrl` 直链免签名、免 Referer,支持 Range(206)。链接有时效
(`UrlExpire`),过期重走 track_v2 即可。备份链 `BackupPlayUrl` 同源。
