# 07 · 接口清单(全部实测验证)

> 2026-10 实测。`<PC参数>`/`<移动参数>` 指设备公共参数,见 05/06 章。
> Cookie:SVIP 会话。门禁:🟢 免签名 · 🟡 Cookie · 🔴 应用级签名。

## 1. 数据面(免签名 / 仅 Cookie)

### 1.1 搜索 🟡

```
GET https://api.qishui.com/luna/search/track?<移动参数>&q=<关键词>&cursor=0&count=20
Cookie: <会话>
UA: com.luna.music/8986 (Linux; U; Android 14; …)
```

响应:`result_groups[]`(分组),每组 `data[]` 内条目 `entity.track_wrapper.track`。
曲目对象:`id/name/duration/artists[]/album/label_info(权益)/audition_info`。

### 1.2 歌单详情 🟡(移动族,免签名)

```
GET https://api.qishui.com/luna/playlist/detail?<移动参数>&playlist_id=<id>
```

响应:`playlist` + `media_resources[]`(条目 `entity.track_wrapper.track`),
219 首歌单实测 1.2MB 全量返回。

### 1.3 我的歌单列表 🟡

```
GET https://api.qishui.com/luna/me/playlist?<移动参数>&cursor=0&count=20
```

响应:`playlists[]`(自建);收藏歌单在 `collection/mixed`。

### 1.4 相关推荐 🟡

```
POST https://api.qishui.com/luna/media/related?<移动参数>
{"track_id":"<id>","media_type":"track"}
```

响应:`items[].entity.track_wrapper.track`(6 首,含 `label_info`)。
注意:不含锚点曲目本身,也不含播放信息。

### 1.5 播放历史 / 收藏 🟡

```
GET /luna/me/recently-played-media?<移动参数>&cursor=0&count=10
GET /luna/me/collection/mixed?<移动参数>&cursor=0&count=20
```

### 1.6 会话与权益 🟡

```
GET https://api.qishui.com/luna/pc/me?<PC参数>
→ my_info: { nickname, is_vip, vip_stage, douyin_id, … }
→ status_code: 0 有效 / 1000016 失效
```

## 2. 试听面(无签名即响应)🟢

```
GET https://api.qishui.com/luna/h5/track_v2?<PC参数或web参数>&track_id=<id>&media_type=track
GET https://beta-luna.douyin.com/luna/h5/seo_track?…(Mineradio 使用的旧入口)
```

- 返回 `track`(全曲元数据 + `bit_rates` + `audition_info`)+ `lyric`(**逐字歌词**)+
  `track_player.url_player_info`;
- `PlayInfoList` 仅一条试听流:30~60s、未加密(`EncryptionMethod=""`)、无 `PlayAuth`;
- ⚠️ 带上服务端不认识的 `msToken` 参数 → `status_code=1000062`,**比不带更糟**;
- 试听 URL 直连可播(206 Range),无需任何头。

## 3. 完整版权益面(应用级签名)🔴

### 3.1 取流主接口

```
POST https://api.qishui.com/luna/pc/track_v2?<PC参数>
Cookie + X-SS-STUB(body MD5 大写) + x-luna-* + X-Helios + X-Medusa
{"track_id":"…","media_type":"track","queue_type":"favorite_track_playlist","scene_name":"library"}
```

失败形态对照:

| 缺什么 | 现象 |
| --- | --- |
| 全部头都无签名 | HTTP 200,**空 body** |
| 带 Web 签名(a_bogus) | HTTP 200,空 body(PC 族不认 Web 形态) |
| 会话失效 | `status_code: 1000016` |
| 风控 | 响应头 `bdturing-verify` / `x-tt-verify-passport-decision`(需官方组件) |

### 3.2 账号歌单族(同签名要求)

```
GET /luna/pc/me/playlist?count=20&cursor=        自建歌单(游标翻页)
GET /luna/pc/me/collection/mixed?…               收藏(混合:playlist+album,按 item_type 分)
GET /luna/pc/playlist/detail?playlist_id=&count=&cursor=   账号歌单曲目(纯偏移游标)
GET /luna/pc/search/playlist?q=&cursor=…          歌单搜索
GET /luna/pc/search/mixed?q=…                     混合搜索(含歌单分组)
```

翻页纪律(实测坑):

- `has_more` 为真就必须继续,**不能以"本页 0 条"收尾**(中间页可能为空但还有后半);
- `count_tracks` 字段偏小(标 186 实际 238),游标才是准的;
- `cursor` 重复/不前进 = 终止条件。

### 3.3 二跳取流 🟢(免签名)

```
GET <track_player.url_player_info>     ← AWS4 预签名,直接 GET
→ Result.Data.PlayInfoList[]:MainPlayUrl / BackupPlayUrl / PlayAuth /
  EncryptionMethod("cenc-aes-ctr") / Bitrate / Duration / UrlExpire
```

### 3.4 音频直链 🟢

```
GET <MainPlayUrl>   Range: bytes=0-  → 206
```

无 Referer/签名要求,`UrlExpire` 内有效,过期重走 3.1。

## 4. 登录族(Web 签名)

```
GET  https://api.qishui.com/passport/web/get_qrcode/?next=https://api.qishui.com&need_logo=false&need_short_url=false
POST https://api.qishui.com/passport/web/check_qrconnect/   (token,is_frontier=true,is_new_login=1,next)
     → data.status: "new"|"scanned"|"3";error_code 2046 = 二次验证
扫码链接: https://bff-pc.qishui.com/light/invoke/scan_login?token=<t>&os=Windows&computer_name=<名>
```

## 5. 错误码速查

| 码 | 含义 | 处置 |
| --- | --- | --- |
| `0`(或缺省) | 成功 | — |
| `1000016` | 会话失效 | 清凭据,重新登录 |
| `1000005` | track_id 无效 | 检查 ID 来源 |
| `1000004` | 参数错误 | 补参数(不是签名问题) |
| `1000062` | msToken 无效 | **去掉 msToken**,别伪造 |
| `2046`(登录) | 风控二次验证 | 官方验证组件闭环 |
| HTTP 200 + 空 body | 应用级签名缺失 | 上 bdms.node 桥 |
| HTTP 404 | 端点已下线(如 `feed/song-tab`) | 换现行端点 |
