(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HongguoWebOSUpdateManifest = api;
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  var APP_ID = 'com.aston314.hongguo.webos';
  var BASE = 'https://github.com/aston314/hongguo-tv-releases/releases/tag/';
  function parts(version) {
    if (typeof version !== 'string' || !/^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$/.test(version)) throw new Error('Invalid webOS version');
    return version.split('.').map(Number);
  }
  function compare(a, b) {
    var x = parts(a), y = parts(b);
    for (var i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
    return 0;
  }
  function validate(value) {
    if (!value || value.schema !== 1 || value.platform !== 'webos' || value.app_id !== APP_ID) throw new Error('Wrong webOS update channel');
    parts(value.version_name);
    var tag = 'webos-v' + value.version_name + '-test.26';
    if (value.release_tag !== tag || value.release_url !== BASE + tag) throw new Error('Invalid webOS release URL');
    if (typeof value.release_notes !== 'string' || value.release_notes.length > 16000) throw new Error('Invalid webOS release notes');
    if (value.artifact_name !== 'hongguo-webos-' + value.version_name + '-test.26.ipk' ||
        typeof value.artifact_size !== 'number' || value.artifact_size <= 0 || value.artifact_size > 100 * 1024 * 1024 || Math.floor(value.artifact_size) !== value.artifact_size ||
        typeof value.artifact_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.artifact_sha256)) throw new Error('Invalid webOS release artifact');
    return { schema: 1, platform: 'webos', app_id: APP_ID, version_name: value.version_name,
      release_tag: tag, release_url: BASE + tag, release_notes: value.release_notes,
      artifact_name: value.artifact_name, artifact_size: value.artifact_size, artifact_sha256: value.artifact_sha256 };
  }
  return { compare: compare, validate: validate };
}));
