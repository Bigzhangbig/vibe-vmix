'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { AppError } = require('../core/errors');
const { json, method, readObject } = require('./http-utils');
const { writePngZip } = require('./png-zip');

const prefix = '/api/stage/concert-export';
const maxFrames = 600;
const maxFrame = 24 * 1024 * 1024;
const maxJob = 1536 * 1024 * 1024;
const pngSig = Buffer.from('89504e470d0a1a0a', 'hex');

function validatePng(frame) {
  if (frame.length < 45 || !frame.subarray(0, 8).equals(pngSig) ||
      frame.readUInt32BE(8) !== 13 || frame.toString('ascii', 12, 16) !== 'IHDR' ||
      frame.readUInt32BE(16) !== 1920 || frame.readUInt32BE(20) !== 1080 ||
      frame[24] !== 8 || ![2, 6].includes(frame[25]) ||
      frame.toString('ascii', frame.length - 8, frame.length - 4) !== 'IEND') {
    throw new AppError('导出帧应为 1920×1080 的 RGB/RGBA PNG');
  }
}

function makeStageExport({ ffmpeg = process.env.BROADCAST_FFMPEG || 'ffmpeg' } = {}) {
  let movAvailable, work;
  const jobs = new Map();
  function caps() {
    if (movAvailable === undefined) {
      const check = spawnSync(ffmpeg, ['-hide_banner', '-encoders'],
        { encoding: 'utf8', timeout: 2500, windowsHide: true });
      movAvailable = check.status === 0 && /\bprores_ks\b/.test(check.stdout);
    }
    return { ok: true, mov: movAvailable, maxFrames };
  }
  const erase = (job) => {
    jobs.delete(job.id);
    if (job.child) job.child.kill();
    fs.rmSync(job.dir, { recursive: true, force: true, maxRetries: 2 });
  };
  const timer = setInterval(() => {
    for (const job of jobs.values()) {
      if (!job.busy && Date.now() - job.touch > 15 * 60 * 1000) {
        try { erase(job); } catch (error) { console.warn('Export cache cleanup:', error.code); }
      }
    }
  }, 60_000);
  timer.unref();
  async function frameBody(req, remaining) {
    if (!/^image\/png(?:;|$)/i.test(req.headers['content-type'] || ''))
      throw new AppError('需要 image/png', 415);
    const max = Math.min(maxFrame, remaining);
    const hinted = Number(req.headers['content-length'] || 0);
    if (hinted > max) throw new AppError('导出任务过大，请缩短动画时长', 413);
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size <= max) chunks.push(chunk);
    }
    if (size > max) throw new AppError('导出任务过大，请缩短动画时长', 413);
    return Buffer.concat(chunks, size);
  }
  function encode(job, output) {
    return new Promise((resolve, reject) => {
      job.child = execFile(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-framerate', String(job.fps), '-start_number', '0',
        '-i', path.join(job.dir, 'frame_%05d.png'), '-frames:v', String(job.frameCount), '-an',
        '-vf', 'scale=out_color_matrix=bt709', '-colorspace', 'bt709',
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
        '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le',
        '-alpha_bits', '16', '-vendor', 'apl0', '-threads', '4', '-movflags', '+faststart',
        output,
      ], { timeout: 300_000, windowsHide: true }, (error, stdout, stderr) => {
        job.child = null;
        if (error) reject(new AppError('FFmpeg 编码失败：' + (stderr || error.code || '').trim().slice(0, 240), 422));
        else resolve();
      });
    });
  }
  async function route(req, res, pathname) {
    if (pathname !== prefix && !pathname.startsWith(prefix + '/')) return false;
    const sub = pathname.slice(prefix.length);
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '') ||
          !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
          ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) {
        throw new AppError('仅本机控制台可以导出', 403);
      }
    }
    if (!sub && req.method === 'GET') {
      json(res, caps());
      return true;
    }
    if (!sub) {
      method(req, 'POST');
      const { format, fps, frameCount } = await readObject(req, 2048);
      if (!['png', 'mov'].includes(format) || !Number.isInteger(fps) || fps < 1 || fps > 60 ||
          !Number.isInteger(frameCount) || frameCount < 1 || frameCount > maxFrames) {
        throw new AppError('帧率应为 1–60，单次最多导出 600 帧');
      }
      if (format === 'mov' && !caps().mov)
        throw new AppError('MOV 需要本机 FFmpeg（prores_ks）', 503);
      for (const job of jobs.values()) {
        if (!job.busy && Date.now() - job.touch > 15 * 60 * 1000) erase(job);
      }
      if ([...jobs.values()].filter((job) => !job.output).length >= 2)
        throw new AppError('已有导出任务，请等待或取消后再试', 409);
      while (jobs.size >= 5) {
        const completed = [...jobs.values()].find((job) => job.output && !job.busy);
        if (!completed) throw new AppError('导出缓存正忙，请稍后重试', 409);
        erase(completed);
      }
      work ||= fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-stage-export-'));
      const id = crypto.randomBytes(16).toString('hex'), dir = path.join(work, id);
      fs.mkdirSync(dir);
      jobs.set(id, { id, dir, fps, format, frameCount, frames: [], bytes: 0, touch: Date.now() });
      json(res, { ok: true, id }, 201);
      return true;
    }
    const hit = /^\/([\da-f]{32})(?:\/(frame\/\d{1,4}|finish|download))?$/.exec(sub);
    const job = hit && jobs.get(hit[1]);
    if (!job) throw new AppError('此导出任务已不存在', 404);
    job.touch = Date.now();
    if (job.busy) throw new AppError('导出任务正忙', 409);
    if (!hit[2]) {
      method(req, 'DELETE');
      erase(job);
      json(res, { ok: true });
      return true;
    }
    if (hit[2] === 'download') {
      if (!['GET', 'HEAD'].includes(req.method)) throw new AppError('use GET', 405);
      if (!job.output) throw new AppError('导出尚未完成', 409);
      job.busy = true;
      try {
        const { size } = await fs.promises.stat(job.output);
        res.writeHead(200, {
          'Content-Type': job.format === 'mov' ? 'video/quicktime' : 'application/zip',
          'Content-Disposition': 'attachment; filename="' + path.basename(job.output) + '"',
          'Content-Length': size,
        });
        if (req.method === 'HEAD') res.end();
        else await pipeline(fs.createReadStream(job.output), res);
      } finally { job.busy = false; }
      return true;
    }
    method(req, 'POST');
    job.busy = true;
    try {
      if (hit[2].startsWith('frame/')) {
        const index = Number(hit[2].slice(6));
        if (job.output || index !== job.frames.length || index >= job.frameCount)
          throw new AppError('帧序号须从 0 开始连续上传', 409);
        const frame = await frameBody(req, maxJob - job.bytes);
        validatePng(frame);
        const filename = path.join(job.dir, 'frame_' + String(index).padStart(5, '0') + '.png');
        await fs.promises.writeFile(filename, frame);
        job.frames.push(filename);
        job.bytes += frame.length;
        json(res, { ok: true });
      } else {
        if (job.frames.length !== job.frameCount) throw new AppError('序列帧尚未上传完毕', 409);
        if (!job.output) {
          const output = path.join(job.dir, job.format === 'mov' ? 'bit-autumn-prores4444.mov' : 'bit-autumn-png-sequence.zip');
          if (job.format === 'mov') await encode(job, output);
          else await writePngZip(output, job.frames);
          job.output = output;
          await Promise.allSettled(job.frames.map((frame) => fs.promises.unlink(frame)));
        }
        json(res, { ok: true, url: prefix + '/' + job.id + '/download' });
      }
    } finally {
      job.busy = false;
      job.touch = Date.now();
    }
    return true;
  }
  function close() {
    clearInterval(timer);
    for (const job of jobs.values()) if (job.child) job.child.kill();
    jobs.clear();
    if (work) fs.promises.rm(work, { recursive: true, force: true, maxRetries: 4, retryDelay: 130 }).catch(() => {});
  }
  return { route, close };
}
module.exports = { makeStageExport };
