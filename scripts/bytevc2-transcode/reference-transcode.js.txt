// SPDX-License-Identifier: GPL-3.0-only
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { assertUnencryptedMp4 } = require('./hongguo');

function binaryPath() {
  if (process.env.HONGGUO_BVC2_FFMPEG) return process.env.HONGGUO_BVC2_FFMPEG;
  const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  return process.resourcesPath
    ? path.join(process.resourcesPath, 'bytevc2', executable)
    : path.resolve(__dirname, '../../../build/bytevc2', process.arch, executable);
}

async function transcodeBytevc2(buffer, key, signal) {
  signal?.throwIfAborted();
  if (!Buffer.isBuffer(key) || ![0, 16].includes(key.length)) throw new Error('ByteVC2 片源密钥无效');
  if (!key.length) assertUnencryptedMp4(buffer);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hongguo-bvc2-'));
  const input = path.join(dir, 'input.mp4');
  const output = path.join(dir, 'output.mp4');
  try {
    await fs.writeFile(input, buffer, { mode: 0o600, signal });
    await new Promise((resolve, reject) => {
      let settled = false;
      let errors = '';
      let stoppedReason;
      const done = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(sizeCheck);
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      };
      const child = spawn(binaryPath(), ['-hide_banner', '-loglevel', 'error', '-nostdin',
        ...(key.length ? ['-decryption_key', key.toString('hex')] : []),
        '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-y', output],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      const abort = () => child.kill();
      const timer = setTimeout(() => { stoppedReason = 'ByteVC2 视频转换超时'; child.kill(); }, 5 * 60 * 1000);
      timer.unref?.();
      const sizeCheck = setInterval(() => {
        fs.stat(output).then(stat => {
          if (stat.size >= 128 * 1024 * 1024 && !settled) {
            stoppedReason = 'ByteVC2 视频转换结果过大';
            child.kill();
          }
        }).catch(() => {});
      }, 500);
      sizeCheck.unref?.();
      child.stderr.on('data', data => { if (errors.length < 4096) errors += data.toString().slice(0, 4096 - errors.length); });
      child.on('error', error => done(Object.assign(new Error('ByteVC2 转码器不可用，请重新安装播放器'), { code: 'BYTEVC2_TRANSCODER_UNAVAILABLE', cause: error })));
      child.on('close', code => {
        if (signal?.aborted) return done(signal.reason || new Error('播放已取消'));
        if (stoppedReason) return done(Object.assign(new Error(stoppedReason), { code: 'BYTEVC2_TRANSCODE_FAILED' }));
        if (code !== 0) return done(Object.assign(new Error('ByteVC2 视频转换失败'), { code: 'BYTEVC2_TRANSCODE_FAILED', detail: errors }));
        done();
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    const stat = await fs.stat(output);
    if (!stat.size || stat.size >= 128 * 1024 * 1024) throw new Error('ByteVC2 视频转换结果过大或为空');
    return await fs.readFile(output, { signal });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
async function* streamBytevc2(buffer, key, signal) {
  signal?.throwIfAborted();
  if (!Buffer.isBuffer(key) || ![0, 16].includes(key.length)) throw new Error('ByteVC2 片源密钥无效');
  if (!key.length) assertUnencryptedMp4(buffer);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hongguo-bvc2-stream-'));
  let child;
  let completion;
  let timer;
  let abort;
  try {
    const input = path.join(dir, 'input.mp4');
    await fs.writeFile(input, buffer, { mode: 0o600, signal });
    child = spawn(binaryPath(), ['-hide_banner', '-loglevel', 'error', '-nostdin',
      ...(key.length ? ['-decryption_key', key.toString('hex')] : []),
      '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25',
      '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    child.stderr.on('data', data => { if (errors.length < 4096) errors += data.toString().slice(0, 4096 - errors.length); });
    completion = new Promise(resolve => {
      child.once('error', error => resolve({ error }));
      child.once('close', code => resolve({ code }));
    });
    abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(abort, 5 * 60 * 1000);
    timer.unref?.();
    let size = 0;
    for await (const chunk of child.stdout) {
      signal?.throwIfAborted();
      size += chunk.length;
      if (size > 128 * 1024 * 1024) throw new Error('ByteVC2 视频转换结果过大');
      yield chunk;
    }
    const result = await completion;
    signal?.throwIfAborted();
    if (result.error || result.code !== 0 || !size) throw Object.assign(new Error('ByteVC2 视频转换失败'), { code: 'BYTEVC2_TRANSCODE_FAILED', detail: errors });
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
    if (child) { child.kill(); await completion; }
    await fs.rm(dir, { recursive: true, force: true });
  }
}
module.exports = { binaryPath, transcodeBytevc2, streamBytevc2 };
