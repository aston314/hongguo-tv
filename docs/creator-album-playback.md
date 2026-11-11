# Creator album playback

Verified anonymously on 2026-11-11 with 《反相之地》续集 (album
`7699818221737610265`). This is a creator collection, distinct from ordinary
short dramas and multi-season drama albums.

- App search returns `content_type=1003` and nested `album_info`. Its
  `video_detail_list` contains only a preview, although `episode_cnt=15`.
- Signed `POST /novel/player/album_detail/v1/` on the existing App API host,
  body `{album_id:"…",series_ids:[],need_video_detail_info:true,
  biz_param:{video_platform:3}}`, returns `code=0`, `data.album_data` and the
  complete ordered `video_detail_list` (15 uploads for this sample). No cursor
  is returned. Incomplete counts, pagination flags, wrong IDs, duplicate IDs
  and unexpected upload types are rejected rather than renumbered.
- Each row uses `series_id_str` as its playback ID and `content_type=1001`.
  Nested preview `video_list[0].vid` may be empty. Existing playback providers
  and media decryption remain responsible for fetching media.
- Collection identity stays `1003` in metadata, favorites and watch history;
  only playback requests map it to `1001`, including quality and prefetch.
  Ordinary drama details and playback retain their existing routes.
- The official public share page exposes a 30-second preview of one upload;
  it is not a full-content or full-directory fallback.

The sanitized fixture contains all 15 IDs/titles without account, device,
share or signed image parameters. Core and webOS use the same fixture.
