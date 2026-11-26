'use strict';
// Opt-in live directory -> production resolver -> complete decrypted media.
// No signed URL, encryption key, session or raw upstream response is logged.
if (process.env.HONGGUO_LIVE_SERIES_DIRECTORY !== '1') {
  console.log('webOS series directory live verification: skipped (opt-in)');
  process.exit(0);
}
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-directory-webos-live-'));
process.env.HONGGUO_WEBOS_CACHE_DIR = root;
process.env.HONGGUO_WEBOS_DATA_DIR = root;
require('../webos/service/runtime-compat');
const provider = require('../webos/service/provider');
const profile = require('../webos/service/playback-profile-service')({dataDir: root, resolve: provider.resolveProfile});
provider.setPlaybackProfile(profile);
const control = require('../webos/service/audio-cancel').create();
const deadline = setTimeout(() => control.abort(), 180000);
(async () => {
  try {
    for (const sample of [
      {series: '7687919221593885758', episode: 4, total: 76},
      {series: '7704857878514895896', episode: 153, total: 193},
      {series: '7690163276214176792', episode: 209, total: 209}
    ]) {
      const detail = await provider.detail(sample.series);
      if (detail.episodes.length !== sample.total || detail.vid_list.length !== sample.total) throw Error('DIRECTORY_INCOMPLETE');
      const vid = detail.vid_list[sample.episode - 1];
      if (sample.episode === 153 && vid !== '7704857946630409240') throw Error('EPISODE_IDENTITY_MISMATCH');
      const started = Date.now();
      const result = await provider.prepare(sample.series, vid, '1080P', true, 'full', false, control.signal, '1004');
      const token = path.basename(result.path, '.mp4');
      const file = path.join(root, token, token + '.mp4');
      const media = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,width,height:format=duration,size', '-of', 'json', file], {timeout: 15000}));
      const video = media.streams.find(s => s.codec_type === 'video');
      if (!video || !['hevc', 'h264'].includes(video.codec_name) || !media.streams.some(s => s.codec_type === 'audio')) throw Error('MEDIA_CODEC_MISMATCH');
      execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-'], {timeout: 90000, stdio: ['ignore', 'pipe', 'pipe']});
      console.log(JSON.stringify({series: sample.series, directory: detail.episodes.length, episode: sample.episode, vid,
        codec: video.codec_name, width: video.width, height: video.height, quality: result.quality,
        bytes: media.format.size, duration: media.format.duration, prepare_and_decode_ms: Date.now() - started, full_decode: true}));
    }
  } catch (error) {
    console.error(JSON.stringify({result: 'FAIL', code: error.code || 'LIVE_MEDIA_FAILED', stage: error.stage || ''}));
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    control.abort();
    provider.closeCache();
    await profile.close();
    fs.rmSync(root, {recursive: true, force: true});
  }
})();
