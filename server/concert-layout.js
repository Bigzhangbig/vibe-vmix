'use strict';
const FONT_FAMILY = 'Shanggu Sans SC';
const LAYOUT_VERSION = 4;
const TEXT_DEFAULT = {
  font: FONT_FAMILY,
  weight: 700,
  lh: 1.2,
  color: '#ffffff',
  align: 'center',
  shadow: true,
  shadowX: 0,
  shadowY: 3,
  shadowBlur: 10,
  shadowColor: '#000000',
  shadowOpacity: 55,
  glow: false,
  glowBlur: 24,
  glowColor: '#ffffff',
  glowOpacity: 35,
};
function textRect(x, y, w, h, size, extra) {
  return { x, y, w, h, ...TEXT_DEFAULT, size, ...extra };
}
const ANNOUNCE_PRESETS = {
  'lower-left': {
    announceBg: { x: -96, y: 140, w: 1728, h: 972 },
    announceText: { x: 201, y: 725, w: 495, h: 243, size: 46 },
  },
  center: {
    announceBg: { x: 166, y: -480, w: 2496, h: 1404 },
    announceText: { x: 595, y: 365, w: 715, h: 351, size: 62 },
  },
};
const DEFAULT_LAYOUT = {
  announceBg: { ...ANNOUNCE_PRESETS['lower-left'].announceBg },
  announceText: textRect(201, 725, 495, 243, 46),
  lyricBg: { x: -210, y: 710, w: 768, h: 432 },
  lyricText: textRect(270, 835, 1040, 130, 52, { align: 'left' }),
  qualifyBg: { x: 578, y: -360, w: 2496, h: 1404 },
  qualifyTitle: textRect(1010, 485, 715, 70, 40),
  qualifyText: textRect(1010, 565, 715, 250, 48),
  creditsBg: { x: 0, y: 0, w: 1920, h: 1080 },
  creditsText: textRect(560, 90, 800, 900, 34, { lh: 1.9 }),
  badge: { x: 1260, y: 620, w: 864, h: 486 },
};
const V3_DEFAULTS = {
  announceBg: { x: 0, y: 0, w: 1920, h: 1080 },
  announceText: { x: 330, y: 650, w: 550, h: 270, size: 52 },
  lyricBg: { x: 0, y: 0, w: 1920, h: 1080 },
  lyricText: { x: 510, y: 700, w: 900, h: 210, size: 60, align: 'center' },
  qualifyBg: { x: 1010, y: 250, w: 760, h: 420 },
  qualifyTitle: { x: 1020, y: 262, w: 740, h: 72, size: 38 },
  qualifyText: { x: 1020, y: 344, w: 740, h: 300, size: 48 },
  badge: { x: 0, y: 0, w: 1920, h: 1080 },
};
const TEXT_IDS = Object.keys(DEFAULT_LAYOUT).filter((id) => DEFAULT_LAYOUT[id].size != null);
const GEOMETRY_KEYS = ['x', 'y', 'w', 'h', 'scale'];
const GEOMETRY_GROUPS = [
  ['announceBg', 'announceText'],
  ['lyricBg', 'lyricText'],
  ['qualifyBg', 'qualifyTitle', 'qualifyText'],
  ['badge'],
];
function placementFor(layout) {
  return (
    Object.keys(ANNOUNCE_PRESETS).find((placement) =>
      Object.entries(ANNOUNCE_PRESETS[placement]).every(
        ([id, defaults]) =>
          Object.entries(defaults).every(([key, value]) => layout[id][key] === value) &&
          (layout[id].scale ?? 1) === 1,
      ),
    ) || 'custom'
  );
}
function migrateLayout(state) {
  const before = JSON.stringify([state.layoutVersion, state.layout, state.announcePlacement]);
  const oldLayout = state.layout || {};
  const upgrading = (state.layoutVersion || 0) < LAYOUT_VERSION;
  const hadQualifyTitle = !!oldLayout.qualifyTitle;
  const legacyQualify = oldLayout.qualifyText ? { ...oldLayout.qualifyText } : null;
  const canMigrate = new Map();
  for (const group of GEOMETRY_GROUPS) {
    const unchanged = group.every((id) => {
      const saved = oldLayout[id];
      const old = V3_DEFAULTS[id];
      return (
        !saved ||
        GEOMETRY_KEYS.every(
          (key) =>
            (saved[key] ?? old[key] ?? (key === 'scale' ? 1 : undefined)) ===
            (old[key] ?? (key === 'scale' ? 1 : undefined)),
        )
      );
    });
    for (const id of group) canMigrate.set(id, unchanged);
  }
  for (const [id, defaults] of Object.entries(DEFAULT_LAYOUT)) {
    const saved = oldLayout[id];
    const old = V3_DEFAULTS[id];
    const preserveGroup = upgrading && old && !canMigrate.get(id);
    const merged = { ...defaults, ...(preserveGroup ? old : {}), ...saved };
    if (upgrading && saved && old) {
      const unchanged = canMigrate.get(id);
      if (unchanged) {
        for (const key of ['x', 'y', 'w', 'h']) merged[key] = defaults[key];
        delete merged.scale;
      }
      for (const key of unchanged ? ['size', 'align'] : []) {
        if (Object.hasOwn(old, key) && (saved[key] ?? old[key]) === old[key])
          merged[key] = defaults[key];
      }
    }
    oldLayout[id] = merged;
  }
  if ((state.layoutVersion || 0) < 3 && !hadQualifyTitle && legacyQualify) {
    const legacy = legacyQualify;
    const untouched = legacy.x === 1020 && legacy.y === 268 && legacy.w === 740 && legacy.h === 384;
    if (untouched) {
      for (const key of ['x', 'y', 'w', 'h'])
        oldLayout.qualifyText[key] = DEFAULT_LAYOUT.qualifyText[key];
    } else {
      oldLayout.qualifyTitle = {
        ...oldLayout.qualifyTitle,
        x: legacy.x,
        w: legacy.w,
        y: Math.max(0, legacy.y - 82),
      };
    }
  }
  for (const id of TEXT_IDS) delete oldLayout[id].scale;
  state.layout = oldLayout;
  state.layoutVersion = Math.max(state.layoutVersion || 0, LAYOUT_VERSION);
  state.announcePlacement = placementFor(oldLayout);
  return JSON.stringify([state.layoutVersion, state.layout, state.announcePlacement]) !== before;
}
module.exports = {
  FONT_FAMILY,
  LAYOUT_VERSION,
  DEFAULT_LAYOUT,
  TEXT_IDS,
  ANNOUNCE_PRESETS,
  migrateLayout,
};
