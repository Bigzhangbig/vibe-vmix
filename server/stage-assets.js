'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');
const { AppError } = require('../core/errors');
const { normalizeManifest, findEngine, renderArgs, inspectMOV, collectPNG, zipPNG } = require('./stage-ae');

const kinds = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.webm': 'video',
  '.mp4': 'video',
  '.mov': 'video',
  '.avi': 'video',
  '.gtzip': 'gt',
  '.gtxml': 'gt',
  '.aep': 'ae',
  '.aepx': 'ae',
  '.nbtitle': 'newblue',
  '.nbtlproj': 'newblue',
  '.nbtlpkg': 'newblue',
};
const mime = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.zip': 'application/zip',
};

function createAssetLibrary(directory, { spawnEngine = spawn, env = process.env, platform = process.platform } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const indexFile = path.join(directory, 'library.json');
  let entries = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : [];
  if (!Array.isArray(entries)) throw Error('素材库索引损坏，请恢复备份');
  const jobs = new Map();
  const children = new Set();
  const collectors = new Set();
  let disposed = false;
  function save(entry, update = false) {
    if (disposed) throw Error('舞台模块已卸载');
    const next = update ? entries.map((item) => item.id === entry.id ? entry : item) : [...entries, entry];
    fs.writeFileSync(indexFile + '.tmp', JSON.stringify(next, null, 2));
    fs.renameSync(indexFile + '.tmp', indexFile);
    entries = next;
    return entry;
  }
  function get(id) {
    const entry = entries.find((item) => item.id === id);
    if (!entry) throw new AppError('找不到素材', 404);
    return entry;
  }
  function filename(entry) {
    return entry.sourcePath || path.join(directory, entry.file);
  }
  function metadata(name) {
    const extension = path.extname(name).toLowerCase();
    if (!kinds[extension]) throw new AppError('不支持此文件类型');
    const id = crypto.randomBytes(16).toString('hex');
    return {
      id,
      name: path.basename(name).slice(0, 200),
      kind: kinds[extension],
      file: id + extension,
      createdAt: Date.now(),
    };
  }
  return {
    list: () => entries.map((entry) => ({ ...entry, available: fs.existsSync(filename(entry)) })),
    get,
    filename,
    register(sourcePath) {
      if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath))
        throw new AppError('请选择本地工程');
      const entry = metadata(sourcePath);
      if (!['ae', 'newblue', 'gt'].includes(entry.kind))
        throw new AppError('此入口仅登记 GT、AE 和 NewBlue 工程');
      if (!fs.statSync(sourcePath).isFile()) throw new AppError('工程不存在');
      return save({
        ...entry,
        sourcePath: path.resolve(sourcePath),
        bytes: fs.statSync(sourcePath).size,
      });
    },
    async upload(req, name) {
      const entry = metadata(name);
      const target = path.join(directory, entry.file);
      const temporary = target + '.upload';
      let bytes = 0;
      const limiter = new Transform({
        transform(chunk, encoding, callback) {
          bytes += chunk.length;
          callback(
            bytes > 512 * 1024 * 1024 ? new AppError('单个素材最多 512 MB', 413) : null,
            chunk,
          );
        },
      });
      try {
        await pipeline(req, limiter, fs.createWriteStream(temporary, { flags: 'wx' }));
        if (!bytes) throw new AppError('文件为空');
        fs.renameSync(temporary, target);
        return save({ ...entry, bytes });
      } catch (error) {
        for (const file of [temporary, target]) {
          try {
            fs.unlinkSync(file);
          } catch (_) {
            /* upload never committed */
          }
        }
        throw error;
      }
    },
    async serve(req, res, file) {
      const entry = entries.find((item) => (item.file === file || item.firstFrame === file) && !item.sourcePath);
      if (!entry || !mime[path.extname(file)] || path.basename(file) !== file)
        throw new AppError('找不到素材', 404);
      const target = path.join(directory, file);
      const stat = await fs.promises.stat(target);
      let start = 0,
        end = stat.size - 1,
        partial = false;
      if (req.headers.range) {
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if (!range) throw new AppError('不支持此范围', 416);
        start = Number(range[1]);
        end = range[2] ? Number(range[2]) : end;
        if (start > end || end >= stat.size) throw new AppError('范围超出文件', 416);
        partial = true;
      }
      res.writeHead(partial ? 206 : 200, {
        'Content-Type': mime[path.extname(file)],
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
        ...(entry.kind === 'sequence' && file === entry.file
          ? { 'Content-Disposition': "attachment; filename=ae-png-sequence.zip" } : {}),
        ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}),
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(target, { start, end });
      res.on('close', () => stream.destroy());
      stream.on('error', () => res.destroy()).pipe(res);
    },
    attachAEManifest({ id, manifest }) {
      const entry = get(id);
      if (entry.kind !== 'ae') throw new AppError('请选择 AE 工程');
      const result = normalizeManifest(manifest);
      return save({ ...entry, aeManifestProject: result.project, compositions: result.compositions }, true);
    },
    renderAE({ id, composition, outputModule, format = 'mov' }) {
      if ([...jobs.values()].some((job) => job.status === 'running'))
        throw new AppError('已有 AE 渲染任务', 409);
      const entry = get(id);
      if (entry.kind !== 'ae') throw new AppError('请选择 AE 工程');
      const project = filename(entry);
      if (!fs.existsSync(project)) throw new AppError('AE 工程已移动或不存在', 404);
      const resolvedComps = (entry.compositions || []).filter((comp) => comp.name === composition);
      if (resolvedComps.length > 1)
        throw new AppError('AE 工程存在重名合成；请在 AE 中重命名并重新导出合成清单');
      const output = metadata(entry.name.replace(/\.[^.]+$/, '') + '.mov');
      const job = { id: output.id, status: 'running', log: '', asset: null, format };
      const work = path.join(directory, '.ae-' + output.id);
      const outputFile = path.join(work, format === 'png-sequence' ? 'frame_[#####].png' : 'render.mov');
      const args = renderArgs({ project, composition, outputModule, format, output: outputFile });
      const engine = findEngine(env, platform);
      fs.mkdirSync(work);
      let child;
      try {
        child = spawnEngine(engine, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        fs.rmSync(work, { recursive: true, force: true });
        throw error;
      }
      const finalFiles = [];
      const collector = new AbortController();
      children.add(child);
      collectors.add(collector);
      jobs.set(job.id, job);
      const append = (chunk) => { job.log = (job.log + chunk.toString()).slice(-8000); };
      const forget = async () => {
        collectors.delete(collector);
        await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.once('error', (error) => {
        job.status = 'failed';
        append('\n' + error.message);
      });
      child.once('close', async (code) => {
        children.delete(child);
        try {
          collector.signal.throwIfAborted();
          if (job.status === 'failed') return;
          if (code !== 0) throw Error('AE 渲染未完成，请查看渲染日志');
          if (format === 'mov') {
            const size = await inspectMOV(outputFile);
            const final = path.join(directory, output.file);
            await fs.promises.rename(outputFile, final);
            finalFiles.push(final);
            job.asset = save({ ...output, bytes: size });
          } else {
            const images = await collectPNG(work, collector.signal);
            const zip = output.id + '.zip';
            const firstFrame = output.id + '.png';
            const archiveInWork = path.join(work, 'frames.zip');
            const bytes = await zipPNG(images, work, archiveInWork, collector.signal);
            const final = path.join(directory, zip);
            const first = path.join(directory, firstFrame);
            await fs.promises.rename(archiveInWork, final);
            finalFiles.push(final);
            await fs.promises.rename(images[0].path, first);
            finalFiles.push(first);
            job.asset = save({
              ...output,
              name: entry.name.replace(/\.[^.]+$/, '') + ' · PNG 序列',
              kind: 'sequence',
              file: zip,
              download: '/assets/' + zip,
              firstFrame,
              bytes,
              frames: images.length,
              width: images[0].width,
              height: images[0].height,
              fps: resolvedComps[0]?.fps || null,
            });
          }
          job.status = 'done';
        } catch (error) {
          await Promise.all(finalFiles.map((file) => fs.promises.rm(file, { force: true }).catch(() => {})));
          job.status = 'failed';
          if (!disposed) append('\n' + error.message);
        } finally {
          await forget();
        }
      });
      return job;
    },
    jobs: () => [...jobs.values()].map((job) => ({ ...job })),
    close() {
      disposed = true;
      for (const collector of collectors) collector.abort();
      for (const child of children) child.kill();
      children.clear();
    },
  };
}
module.exports = { createAssetLibrary };
