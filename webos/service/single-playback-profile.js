'use strict';
// Dedicated anonymous single-episode profile; account and legacy defaults stay
// independent. Matches the protocol verified with openhongguo 0.2.0.
var UA = 'com.phoenix.read/73932 (Linux; U; Android 14; zh_CN; 23127PN0CC; Build/UKQ1.230804.001; Cronet/TTNetVersion:8d40f833 2026-03-03 QuicVersion:21ac1950 2025-11-18)';
function query(d) {
  return { iid: d.installID || '', device_id: d.deviceID || '', ac: 'wifi', channel: 'xiaomi_8662_64', aid: '8662', app_name: 'novelread', cdid: d.cdid,
    version_code: '73932', version_name: '7.3.9.32', device_platform: 'android', os: 'android', ssmix: 'a', device_type: '23127PN0CC', device_brand: 'Xiaomi',
    language: 'zh', os_api: '34', os_version: '14', manifest_version_code: '73932', resolution: '1200*2670', dpi: '460', update_version_code: '73932', host_abi: 'arm64-v8a',
    dragon_device_type: 'phone', pv_player: '73932', compliance_status: '0', need_personal_recommend: '1', player_so_load: '1', is_android_pad_screen: '0', openudid: d.openudid };
}
function payload(plain, d, stamp) {
  var p = JSON.parse(plain.toString('utf8'));
  Object.assign(p.header, { display_name: '红果免费短剧', app_version: '7.3.9.32', app_version_minor: '7.3.9.32', version_code: 73932, manifest_version_code: 73932,
    update_version_code: 73932, channel: 'xiaomi_8662_64', device_brand: 'Xiaomi', device_manufacturer: 'Xiaomi', device_model: '23127PN0CC', os_api: 34, os_version: '14',
    density_dpi: 460, resolution: '2670x1200', device_id: '0', install_id: '0', req_id: d.clientudid,
    oaid: { req_id: d.cdid, hw_id_version_code: '0', take_ms: '6', is_track_limited: 'false', query_times: '1', id: d.cdid, time: String(stamp - 200) } });
  return Buffer.from(JSON.stringify(p));
}
module.exports = { ua: UA, query: query, payload: payload, deviceBase: 'https://log5-applog-lq.fqnovel.com', endpoint: 'https://api5-normal-sinfonlinea.fqnovel.com/novel/player/video_model/v1/' };
