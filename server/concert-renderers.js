'use strict';

const CHANNELS = ['announce', 'lyric', 'qualify', 'credits', 'badge'];
const EXPIRY_MS = 15000;

// These reports describe browser players. vMix remains the final broadcast monitor.
function createRendererRegistry({ now = Date.now } = {}) {
  const outputs = new Map();

  function expire() {
    const oldest = now() - EXPIRY_MS;
    for (const [id, output] of outputs) {
      if (output.updatedAt < oldest) outputs.delete(id);
    }
  }

  function report(body) {
    if (!body || typeof body.id !== 'string' || !/^[\w-]{1,80}$/.test(body.id))
      throw new Error('输出实例标识无效');
    if (![body.width, body.height].every((value) => Number.isInteger(value) && value > 0 && value <= 16384))
      throw new Error('输出尺寸无效');
    if (!Array.isArray(body.media) || body.media.length > CHANNELS.length)
      throw new Error('素材状态无效');
    const seen = new Set();
    const media = body.media.map((item) => {
      if (!item || !CHANNELS.includes(item.channel) || seen.has(item.channel) ||
          !Number.isInteger(item.readyState) || item.readyState < 0 || item.readyState > 4)
        throw new Error('素材状态无效');
      seen.add(item.channel);
      return {
        channel: item.channel,
        file: String(item.file || '').slice(0, 200),
        readyState: item.readyState,
        paused: !!item.paused,
        ended: !!item.ended,
        on: !!item.on,
        error: String(item.error || '').slice(0, 1000),
      };
    });
    expire();
    if (!outputs.has(body.id) && outputs.size >= 32) throw new Error('输出实例数量已达上限');
    outputs.set(body.id, {
      id: body.id,
      width: body.width,
      height: body.height,
      updatedAt: now(),
      media,
    });
    return { ok: true };
  }

  function snapshot() {
    expire();
    return { now: now(), outputs: structuredClone([...outputs.values()]) };
  }

  return { report, snapshot };
}

module.exports = { createRendererRegistry };
