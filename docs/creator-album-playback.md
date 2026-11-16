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

## Cloud metadata compatibility (2026-11-16)

The signed `POST /novel/player/multi_video_detail/preload/v1` batch request
uses `{dr_scene:"preload",series_id:"<comma-separated IDs>",biz_param:{...}}`
on the existing account API host. Unlike search, its `data[id].video_data`
for the same creator album contains `content_type=1003`, matching numeric
`series_id` and string `series_id_str`, and `series_title`, but no `album_info`.
It reports `episode_cnt=0` although `album_detail` still returns 15 uploads.

The Go card normalizer accepts this flat shape only when the nested field is
absent. Present but malformed/inconsistent nested data is still rejected;
all reported identities must agree. Card normalization never invents uploads
or replaces the dedicated directory request. This repairs the sync regression
introduced when nested-only normalization was shared with cloud metadata.

`cloud-metadata-creator-album.json` preserves the public response's relevant
fields, including both exact 19-digit ID representations; it contains no
account, device or signed image data. Tests replay this sample through metadata,
history/favorite merge, progress/favorite upload and the full-directory route.
These are public API/schema and local regression checks, not a claim of a new
authenticated end-to-end sync test.
