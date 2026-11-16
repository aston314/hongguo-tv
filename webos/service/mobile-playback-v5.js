'use strict';
var zlib = require('zlib');
var signer = require('./playback-v5-sign');
var ENDPOINT =
  'https://api5-normal-sinfonlinea.fqnovel.com/novel/player/multi_video_model/player/v1';
var UA =
  'com.phoenix.read/73932 (Linux; U; Android 12; zh_CN_#Hans; PGT-AN10; Build/V417IR;tt-ok/3.12.13.20)';
function query(d) {
  return {
    aid: '8662',
    app_name: 'novelread',
    version_code: '74332',
    version_name: '7.4.3.32',
    channel: 'vivo_8662_64',
    device_platform: 'android',
    device_type: 'PGT-AN10',
    os_version: '12',
    update_version_code: '74332',
    iid: d.installID,
    cdid: d.cdid,
    device_id: d.deviceID
  };
}
function build(vid, contentType, device, stamp) {
  if (!/^[0-9]{1,32}$/.test(vid) || !/^[0-9]{1,16}$/.test(contentType))
    throw new Error('invalid playback episode');
  var ids = {};
  ids[contentType] = [vid];
  var body = zlib.gzipSync(
    Buffer.from(
      JSON.stringify({
        biz_param: {
          detail_page_version: 0,
          device_level: 3,
          disable_digg_stat: false,
          disable_video_relate_book: false,
          need_all_video_definition: true,
          need_mp4_align: false,
          use_os_player: false,
          use_server_dns: false,
          video_platform: 1024
        },
        mixed_video_id_map: ids,
        dr_scene: 'player'
      })
    )
  );
  var signed = signer.sign(query(device), body, stamp);
  return {
    url: ENDPOINT + '?' + signed.query,
    body: body,
    headers: Object.assign({}, signed.headers, {
      'User-Agent': UA,
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip'
    })
  };
}
// Select only the exact requested episode, never the first entry or a direct
// legacy model. The provider checks business status before using this result.
function normalize(envelope, vid, contentType) {
  var data = envelope && envelope.data,
    entries = (data && data[contentType]) || data;
  var entry = entries && entries[vid];
  var result = {};
  if (entry && entry.video_model != null) result[vid] = entry;
  return Object.assign({}, envelope, { data: result });
}
module.exports = { query: query, build: build, normalize: normalize, maxJSON: 2 * 1024 * 1024 };
