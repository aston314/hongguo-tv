// SPDX-License-Identifier: GPL-3.0-only
// Anonymous registration and full v5 query adapted from OOIUa/hongguo-android
// v0.8.0, commit 12e373137e33f0155cbc33484dfdfdfa632c9906.
'use strict';
var device = require('./device-pure'), crypto = require('crypto');
var signer = require('./playback-v5-sign');
var REGISTER = 'https://log5-applog-lf.fqnovel.com/service/2/device_register/?tt_data=a&cronet_version=8d40f833_2026-03-03&ttnet_version=4.2.243.31-douyin&use_store_region_cookie=1';
var REGISTER_UA = 'com.phoenix.read/72232 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3)';
var TAB = 'https://api5-normal-sinfonlineb.fqnovel.com/reading/bookapi/video_tab/multi_video_model/v1/';
var TAB_UA = 'com.phoenix.read/73932 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)';
function error(code) { var e = new Error(code); e.code = code; e.stage = 'device_register'; throw e; }
function payload(d, stamp) {
  return Buffer.from(JSON.stringify({ magic_tag: 'ss_app_log', header: {
    display_name: '红果免费短剧', update_version_code: 73932, manifest_version_code: 73932,
    app_version_minor: '7.3.9.32', aid: 8662, channel: 'update_64', package: 'com.phoenix.read',
    app_version: '7.3.9.32', version_code: 73932, sdk_version: '3.7.0-rc.34-fanqie-xiaoshuo',
    sdk_target_version: 29, git_hash: '3a88f4e', os: 'Android', os_version: '16', os_api: 36,
    device_model: '25053RT47C', device_brand: 'Redmi', device_manufacturer: 'Redmi',
    cpu_abi: 'arm64-v8a', release_build: 'b5e187f', density_dpi: 520, display_density: 'mdpi',
    resolution: '1280x2772', language: 'zh', timezone: 8, access: 'wifi', not_request_sender: 0,
    carrier: 'CHINA MOBILE', mcc_mnc: '46000', rom: 'eng.root.20231116.160340',
    rom_version: 'W528JS release-keys', cdid: d.cdid, sig_hash: '56a962410c494bbaf0b58dba20cae56f',
    openudid: d.openudid, clientudid: d.clientudid, ipv6_list: [], region: 'CN',
    tz_name: 'Asia/Shanghai', tz_offset: 28800, sim_region: 'cn', sim_serial_number: [],
    oaid_may_support: false, req_id: device.uuid(), device_platform: 'android',
    custom: { account_region_src: 'fallback', account_region: 'cn', host_bit: 64, dragon_device_type: 'phone' },
    pre_installed_channel: '', apk_first_install_time: stamp, is_system_app: 0,
    sdk_flavor: 'china', guest_mode: 0
  }, _gen_time: stamp }));
}
function register(http) {
  var d = device.device(), stamp = Date.now();
  var body = device.ttEncrypt(payload(d, stamp), crypto.randomBytes(32));
  var h = { 'User-Agent': REGISTER_UA, Accept: 'application/json',
    'Content-Type': 'application/octet-stream;tt-data=a', 'log-encode-type': 'gzip',
    'x-ss-dp': '8662', 'x-ss-req-ticket': String(stamp), 'x-vc-bdturing-sdk-version': '4.0.3.cn',
    lc: '101', 'sdk-version': '2', 'passport-sdk-version': '5051452',
    'x-neptune': '-8|50:51:59:30:40:47:49:39',
    'x-ss-stub': crypto.createHash('md5').update(body).digest('hex').toUpperCase() };
  return http('POST', REGISTER, h, body).then(function (r) {
    if (r.status !== 200) error('DEVICE_REGISTER_HTTP');
    var bytes = r.body, root;
    try {
      if (bytes.slice(0, 6).equals(Buffer.from([0x74, 0x63, 5, 0x10, 0, 0]))) bytes = device.ttDecrypt(bytes);
      root = device.parseExactJSON(bytes.toString('utf8'));
    } catch (invalidResponse) { error('DEVICE_REGISTER_INVALID'); }
    if (!root || typeof root !== 'object' || Array.isArray(root)) error('DEVICE_REGISTER_INVALID');
    var did = device.str(root.device_id_str || root.device_id), iid = device.str(root.install_id_str || root.install_id);
    if (!device.validID(did) || !device.validID(iid) || !/[1-9]/.test(did) || !/[1-9]/.test(iid)) error('DEVICE_REGISTER_INVALID');
    var egdi = root.klink_egdi || (root.data && root.data.klink_egdi);
    var identity = { deviceID: did, installID: iid, cdid: d.cdid,
      egdi: typeof egdi === 'string' && egdi.length <= 8192 ? egdi.trim() : '' };
    var activate = 'https://log5-applog-lf.fqnovel.com/service/2/app_alert_check/?aid=8662&app_name=novelread&channel=update_64' +
      '&device_id=' + did + '&iid=' + iid + '&device_platform=android&os=android&version_code=73932&version_name=7.3.9.32&_rticket=' + Date.now();
    // Activation is best effort and bounded inside the existing episode budget.
    return http('GET', activate, { 'User-Agent': REGISTER_UA, Accept: 'application/json' }, null, 3000)
      .then(function () { return identity; }, function () { return identity; });
  });
}
function query(d) {
  var q = { device_platform: 'android', os: 'android', ssmix: 'a', cdid: d.cdid,
    channel: 'vivo_8662_64', aid: '8662', app_name: 'novelread', version_code: '74332',
    version_name: '7.4.3.32', manifest_version_code: '74332', update_version_code: '74332',
    resolution: '1920*1080', dpi: '280', device_type: 'PGT-AN10', device_brand: 'HONOR',
    language: 'zh', os_api: '31', os_version: '12', ac: 'wifi', host_abi: 'arm64-v8a',
    dragon_device_type: 'phone', pv_player: '74332', compliance_status: '0',
    need_personal_recommend: '1', player_so_load: '1', is_android_pad_screen: '0',
    rom_version: 'V417IR+release-keys', iid: d.installID, device_id: d.deviceID };
  if (d.egdi) q.klink_egdi = d.egdi;
  return q;
}
function tab(vid, d, stamp) {
  var q = query(d);
  Object.assign(q, { video_id: vid, video_id_type: '0', device_level: '1',
    need_all_video_definition: '1', need_mp4_align: '0', use_os_player: '0',
    video_platform: '1024', source: '0', from_video_id: '' });
  var s = signer.signOfficial(q, Buffer.alloc(0), stamp);
  return { url: TAB + '?' + s.query,
    headers: Object.assign({}, s.headers, { 'User-Agent': TAB_UA, Accept: 'application/json' }) };
}
function selfTest() {
  var rows = require('./official-signing-vectors');
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i], values = query({ deviceID: '123', installID: '456', cdid: 'synthetic', egdi: 'synthetic+egdi' });
    Object.assign(values, { video_id: '123', video_id_type: '0', device_level: '1',
      need_all_video_definition: '1', need_mp4_align: '0', use_os_player: '0',
      video_platform: '1024', source: '0', from_video_id: '' });
    var tuned = signer.tuneKeys(values, Buffer.alloc(0), row.stamp, Object.keys(values).concat(['_rticket']), true);
    var medusa = signer.medusa(values, row.ts, tuned.q, tuned.m,
      [0x80000000, 0x80000000, 0x80000000],
      { nonce: 'synthetic', started: 1800000000000, now: 1800000000000, launch: 110, pid: 11001 }, true);
    if (tuned.query !== row.query || medusa !== row.medusa || signer.helios(row.ts, 0x80000000) !== row.helios) return false;
  }
  return rows.length === 4;
}
module.exports = { register: register, query: query, tab: tab, payload: payload, selfTest: selfTest };
