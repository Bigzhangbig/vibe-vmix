'use strict';

const fs = require('node:fs');
const { basename } = require('node:path');
const { crc32 } = require('node:zlib');

// ZIP32, stored files: PNG is already compressed. Stream in chunks rather than holding an export in RAM.
async function writePngZip(outputPath, frames, signal) {
  signal?.throwIfAborted();
  if (!frames.length || frames.length > 65535) throw Error('PNG 序列帧数超出 ZIP 范围');
  const out = await fs.promises.open(outputPath, 'wx');
  const central = [];
  let offset = 0;
  const names = new Set();
  async function emit(buffer) {
    signal?.throwIfAborted();
    if (offset + buffer.length > 0xffffffff) throw Error('PNG ZIP 超过 4 GiB');
    let done = 0;
    while (done < buffer.length) {
      const { bytesWritten } = await out.write(buffer, done, buffer.length - done, offset + done);
      if (!bytesWritten) throw Error('无法写入 PNG ZIP');
      done += bytesWritten;
    }
    offset += done;
  }
  try {
    for (const frame of frames) {
      const name = basename(frame);
      if (!/^[\w. -]+\.png$/i.test(name) || names.has(name))
        throw Error('PNG 序列文件名无效或重复');
      names.add(name);
      const bytes = Buffer.from(name);
      const start = offset;
      const loc = Buffer.alloc(30);
      loc.writeUInt32LE(0x04034b50, 0);
      loc.writeUInt16LE(20, 4);
      loc.writeUInt16LE(8, 6);
      loc.writeUInt16LE(33, 12);
      loc.writeUInt16LE(bytes.length, 26);
      await emit(loc);
      await emit(bytes);
      let size = 0, crc = 0;
      for await (const data of fs.createReadStream(frame)) {
        size += data.length;
        crc = crc32(data, crc);
        await emit(data);
      }
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(size, 8);
      descriptor.writeUInt32LE(size, 12);
      await emit(descriptor);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(8, 8);
      record.writeUInt16LE(33, 14);
      record.writeUInt32LE(crc, 16);
      record.writeUInt32LE(size, 20);
      record.writeUInt32LE(size, 24);
      record.writeUInt16LE(bytes.length, 28);
      record.writeUInt32LE(start, 42);
      central.push(record, bytes);
    }
    const centralOffset = offset;
    for (const record of central) await emit(record);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(frames.length, 8);
    end.writeUInt16LE(frames.length, 10);
    end.writeUInt32LE(offset - centralOffset, 12);
    end.writeUInt32LE(centralOffset, 16);
    await emit(end);
  } catch (error) {
    await out.close().catch(() => {});
    await fs.promises.rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }
  await out.close();
}

module.exports = { writePngZip };
