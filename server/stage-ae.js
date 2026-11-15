'use strict';

const fs = require('node:fs');
const { promises: fsp } = fs;
const path = require('node:path');
const { writePngZip } = require('./png-zip');
const { AppError } = require('../core/errors');

const EXTENSIONS = Object.freeze(['mov', 'png-sequence']);
const MANIFEST_TYPE = 'vibe-vmix-ae';
const MAX_COMPS = 256;
const MAX_FRAMES = 12000;
// A stored ZIP needs no decompressor and remains compatible with the Windows shell.
// We use ZIP32, so keep a safe margin below its 4 GiB format limit.
const MAX_SEQUENCE_BYTES = 2 * 1024 * 1024 * 1024;

function cleanText(value, max) {
  return typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

function normalizeManifest(value) {
  if (!value || value.kind !== MANIFEST_TYPE || value.version !== 1 ||
      typeof value.project !== 'string' || value.project.length > 500 ||
      !Array.isArray(value.compositions) || !value.compositions.length ||
      value.compositions.length > MAX_COMPS)
    throw new AppError('请选择有效的 AE 合成清单（vibe-vmix-ae，版本 1）');
  const compositions = value.compositions.map((comp) => {
    if (!comp || !cleanText(comp.name, 200) ||
      !Number.isSafeInteger(comp.width) || comp.width < 1 || comp.width > 30000 ||
      !Number.isSafeInteger(comp.height) || comp.height < 1 || comp.height > 30000 ||
      !Number.isFinite(comp.fps) || comp.fps < 1 || comp.fps > 999 ||
      !Number.isFinite(comp.duration) || comp.duration <= 0 || comp.duration > 24 * 3600)
      throw new AppError('AE 清单含无效的合成名称、尺寸、帧率或时长');
    return { name: comp.name, width: comp.width, height: comp.height, fps: comp.fps, duration: comp.duration };
  });
  return { project: value.project, compositions };
}

function findEngine(env = process.env, os = process.platform) {
  const configured = env.BROADCAST_AERENDER;
  if (configured) {
    if (path.isAbsolute(configured) && fs.existsSync(configured) && fs.statSync(configured).isFile()) return configured;
    throw new AppError('BROADCAST_AERENDER 必须指向本机 aerender 的绝对文件路径');
  }
  const folder = os === 'win32'
    ? path.join(env.ProgramFiles || 'C:\\Program Files', 'Adobe')
    : os === 'darwin' ? '/Applications' : null;
  if (folder && fs.existsSync(folder)) {
    const versions = fs.readdirSync(folder)
      .filter((name) => name.startsWith('Adobe After Effects'))
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    for (const version of versions) {
      const candidates = os === 'win32' ? [path.join(folder, version, 'Support Files', 'aerender.exe')]
        : [path.join(folder, version, 'aerender'), path.join(folder, version, version + '.app', 'Contents', 'MacOS', 'aerender')];
      const engine = candidates.find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
      if (engine) return engine;
    }
  }
  throw new AppError('未找到 AE 渲染引擎；请安装 After Effects 或设置 BROADCAST_AERENDER');
}

function renderArgs({ project, composition, outputModule, format, output }) {
  if (!cleanText(composition, 200)) throw new AppError('请填写合成名称');
  if (!cleanText(outputModule, 200)) throw new AppError('请填写 AE 输出模块模板名称');
  if (!EXTENSIONS.includes(format)) throw new AppError('仅支持 MOV 或透明 PNG 序列');
  return ['-project', project, '-comp', composition, '-OMtemplate', outputModule, '-output', output];
}

async function inspectPNG(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(26);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 45 || bytesRead !== buf.length ||
      buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || buf.readUInt32BE(8) !== 13 ||
      buf.toString('ascii', 12, 16) !== 'IHDR')
      throw Error('AE 输出不是有效的 PNG 帧');
    if (![4, 6].includes(buf[25])) throw Error('PNG 未包含 Alpha 通道，请在 AE 输出模块选择「RGB + Alpha」');
    const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
    if (width < 1 || height < 1 || width > 30000 || height > 30000)
      throw Error('PNG 帧的尺寸无效');
    return { width, height, size: stat.size };
  } finally {
    await handle.close();
  }
}

async function inspectMOV(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 24 || bytesRead !== buf.length ||
        !['ftyp', 'wide', 'free', 'mdat', 'moov', 'skip', 'uuid'].includes(buf.toString('latin1', 4, 8)))
      throw Error('AE 输出不是 QuickTime MOV；请在 AE 输出模块选择 QuickTime');
    return stat.size;
  } finally {
    await handle.close();
  }
}

async function collectPNG(folder, signal) {
  const entries = await fsp.readdir(folder, { withFileTypes: true });
  const images = entries.flatMap((entry) => {
    const number = /^frame_(-?\d{1,9})\.png$/i.exec(entry.name);
    return entry.isFile() && number ? [{ path: path.join(folder, entry.name), frame: Number(number[1]) }] : [];
  }).sort((a, b) => a.frame - b.frame);
  if (!images.length || images.length > MAX_FRAMES)
    throw Error('找不到 AE PNG 序列，或序列超过 12000 帧；请检查 AE 输出模块与渲染范围');
  const result = [];
  let bytes = 0;
  for (let i = 0; i < images.length; i++) {
    signal?.throwIfAborted();
    const entry = images[i];
    if (entry.frame !== images[0].frame + i) throw Error('PNG 帧号重复或不连续');
    const png = await inspectPNG(entry.path);
    if (i && (png.width !== result[0].width || png.height !== result[0].height))
      throw Error('PNG 序列尺寸不一致');
    bytes += png.size;
    if (bytes > MAX_SEQUENCE_BYTES) throw Error('PNG 序列超过 2 GiB，请缩短渲染范围');
    result.push({ ...entry, ...png, name: 'frame_' + String(i).padStart(5, '0') + '.png' });
  }
  return result;
}

async function zipPNG(images, work, zipFile, signal) {
  const folder = path.join(work, 'normalized');
  await fsp.mkdir(folder);
  for (const image of images) {
    signal?.throwIfAborted();
    const finalPath = path.join(folder, image.name);
    await fsp.rename(image.path, finalPath);
    image.path = finalPath;
  }
  await writePngZip(zipFile, images.map((image) => image.path), signal);
  return (await fsp.stat(zipFile)).size;
}

module.exports = { normalizeManifest, findEngine, renderArgs, inspectMOV, collectPNG, zipPNG };
