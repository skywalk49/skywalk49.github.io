// 一天中十个时段的视觉参数，以及按当前时刻做平滑插值。
//
// 设计要点：
// 1. 颜色统一用 #rrggbb 字符串，插值在 sRGB 数值空间做（视觉可控）。
// 2. 天空与太阳全部由自绘穹顶绘制（不再叠加 drei 的 <Sky>，
//    因为那个着色器自己也会画太阳，叠加会出现「两个太阳」）。
// 3. `sunStrength` 控制太阳盘亮度；`sunSize` 控制角半径倍数。

export type PeriodKey =
  | "deepNight"
  | "preDawn"
  | "dawn"
  | "sunrise"
  | "morning"
  | "noon"
  | "afternoon"
  | "sunset"
  | "dusk"
  | "night";

export type SkyTheme = {
  skyTop: string;
  skyMid: string;
  skyHorizon: string;

  /** 自绘太阳盘亮度 */
  sunStrength: number;
  /** 太阳光晕强度 */
  sunGlow: number;
  sunGlowColor: string;
  /** 太阳盘半径相对基准值的倍数（1 = 标准，0.5 = 一半） */
  sunSize: number;

  moonOpacity: number;
  starOpacity: number;

  cloudOpacity: number;
  cloudColor: string;
  /** 云的对比与厚度，白天需要更立体 */
  cloudDetail: number;
  /**
   * 云的覆盖率区间 [最少云, 最多云]。
   * 值是 fbm 阈值起点，**越大云越少**（越低=云越密）。
   * 每个时段给一个合理区间，按天随机取值，让每天的云量都不一样。
   */
  cloudCoverRange: [number, number];
  /** 由 cloudCoverRange 按当天种子随机得到的实际取值（sampleSky 产生） */
  cloudCover: number;
  /** 大气散射强度：让天空沿太阳方向自然偏暖、背光侧偏冷 */
  atmosphere: number;

  waterColor: string;
  waterSunColor: string;
  waterDim: number;
  specular: number;
  distortionScale: number;
  /** 水面镜面高光跟随太阳的强度；0 = 不吃直射光（保持原版白天观感） */
  waterSunFollow: number;

  lightA: number;
  lightB: number;

  fogColor: string;
  fogNear: number;
  fogFar: number;
  /** 0 = 无雾 */
  fogStrength: number;

  background: string;

  /** 太阳在屏幕上的归一化落点 */
  sunAnchor: { x: number; y: number };
};

// y 取 0.50 附近即贴着海平线，太阳会半沉。
export const SKY_THEMES: Record<PeriodKey, SkyTheme> = {
  // 深夜：最深最静，星月最亮
  deepNight: {
    skyTop: "#010307",
    skyMid: "#02070f",
    skyHorizon: "#06121f",
    sunStrength: 0,
    sunGlow: 0,
    sunGlowColor: "#7a6a88",
    sunSize: 0.8,
    moonOpacity: 1,
    starOpacity: 1,
    cloudOpacity: 0.58,
    cloudColor: "#28415c",
    cloudDetail: 0.60,
    cloudCoverRange: [0.26, 0.36],
    cloudCover: 0.31,
    atmosphere: 0.1,
    waterColor: "#01060e",
    waterSunColor: "#8aa4c2",
    waterDim: 0.4,
    specular: 0.1,
    distortionScale: 4,
    waterSunFollow: 0.0,
    lightA: 0.38,
    lightB: 0.3,
    fogColor: "#06121f",
    fogNear: 4200,
    fogFar: 13000,
    fogStrength: 1,
    background: "#010307",
    sunAnchor: { x: 0.95, y: 0.64 },
  },

  // 凌晨：天边微亮，星渐隐
  preDawn: {
    skyTop: "#030812",
    skyMid: "#081326",
    skyHorizon: "#16293e",
    sunStrength: 0.05,
    sunGlow: 0.08,
    sunGlowColor: "#7a6a88",
    sunSize: 0.9,
    moonOpacity: 0.72,
    starOpacity: 0.55,
    cloudOpacity: 0.26,
    cloudColor: "#16243a",
    cloudDetail: 0.45,
    cloudCoverRange: [0.4, 0.55],
    cloudCover: 0.475,
    atmosphere: 0.22,
    waterColor: "#020a14",
    waterSunColor: "#7e94b4",
    waterDim: 0.45,
    specular: 0.1,
    distortionScale: 4.05,
    waterSunFollow: 0.0,
    lightA: 0.44,
    lightB: 0.34,
    fogColor: "#132235",
    fogNear: 4200,
    fogFar: 13000,
    fogStrength: 1,
    background: "#030812",
    sunAnchor: { x: 0.95, y: 0.58 },
  },

  // 破晓：第一缕光，冷蓝天配一点点暖
  dawn: {
    skyTop: "#0f1e38",
    skyMid: "#2d4a72",
    skyHorizon: "#8a6c78",
    sunStrength: 0.75,
    sunGlow: 0.55,
    sunGlowColor: "#d88a6a",
    sunSize: 1.0,
    moonOpacity: 0.3,
    starOpacity: 0.12,
    cloudOpacity: 0.6,
    cloudColor: "#8a7a90",
    cloudDetail: 0.6,
    cloudCoverRange: [0.4, 0.52],
    cloudCover: 0.46,
    atmosphere: 0.45,
    waterColor: "#061418",
    waterSunColor: "#c88a72",
    waterDim: 0.55,
    specular: 0.14,
    distortionScale: 4,
    waterSunFollow: 0.15,
    lightA: 0.55,
    lightB: 0.42,
    fogColor: "#3a4a68",
    fogNear: 4200,
    fogFar: 13000,
    fogStrength: 1,
    background: "#1a2c44",
    sunAnchor: { x: 0.94, y: 0.525 },
  },

  // 黎明：日出，暖橘色铺开
  sunrise: {
    skyTop: "#4a6a9a",
    skyMid: "#9a8a9a",
    skyHorizon: "#e8a878",
    sunStrength: 0.95,
    sunGlow: 0.75,
    sunGlowColor: "#ffb070",
    sunSize: 1.25,
    moonOpacity: 0,
    starOpacity: 0,
    cloudOpacity: 0.55,
    cloudColor: "#e8c8b0",
    cloudDetail: 0.8,
    cloudCoverRange: [0.38, 0.5],
    cloudCover: 0.44,
    atmosphere: 0.6,
    waterColor: "#0a1c16",
    waterSunColor: "#ffc090",
    waterDim: 0.68,
    specular: 0.16,
    distortionScale: 3.9,
    waterSunFollow: 0.55,
    lightA: 0.75,
    lightB: 0.6,
    fogColor: "#c89880",
    fogNear: 4600,
    fogFar: 13000,
    fogStrength: 0.8,
    background: "#8ba0b8",
    sunAnchor: { x: 0.93, y: 0.44 },
  },

  // 上午：明亮清澈，天空逐渐交回给 drei Sky
  morning: {
    skyTop: "#7fb0e0",
    skyMid: "#95c0e8",
    skyHorizon: "#c2d8ea",
    sunStrength: 0.9,
    sunGlow: 0.34,
    sunGlowColor: "#fff0d0",
    sunSize: 1.35,
    moonOpacity: 0,
    starOpacity: 0,
    cloudOpacity: 0.44,
    cloudColor: "#ffffff",
    cloudDetail: 0.62,
    cloudCoverRange: [0.44, 0.6],
    cloudCover: 0.52,
    atmosphere: 0.58,
    waterColor: "#02160d",
    waterSunColor: "#ffffff",
    waterDim: 0.62,
    specular: 0.2,
    distortionScale: 3.9,
    waterSunFollow: 0.48,
    lightA: 0.95,
    lightB: 0.78,
    fogColor: "#d2e2f0",
    fogNear: 6000,
    fogFar: 14000,
    fogStrength: 0.18,
    background: "#a2c4e6",
    sunAnchor: { x: 0.9, y: 0.34 },
  },

  // 正午：与原版完全一致，穹顶完全透明
  noon: {
    skyTop: "#78a8dc",
    skyMid: "#8fbae4",
    skyHorizon: "#c0d6ea",
    sunStrength: 1.0,
    sunGlow: 0.3,
    sunGlowColor: "#fff0d0",
    sunSize: 1.45,
    moonOpacity: 0,
    starOpacity: 0,
    cloudOpacity: 0.42,
    cloudColor: "#ffffff",
    cloudDetail: 0.6,
    cloudCoverRange: [0.46, 0.62],
    cloudCover: 0.54,
    atmosphere: 0.55,
    waterColor: "#021710",
    waterSunColor: "#ffffff",
    waterDim: 0.6,
    specular: 0.22,
    distortionScale: 3.95,
    waterSunFollow: 0.5,
    lightA: 1,
    lightB: 0.8,
    fogColor: "#cfe0ef",
    fogNear: 6000,
    fogFar: 14000,
    fogStrength: 0.18,
    background: "#a6c8e8",
    sunAnchor: { x: 0.87, y: 0.29 },
  },

  // 午后：偏暖，光角开始变斜
  afternoon: {
    skyTop: "#85aed4",
    skyMid: "#9cc0de",
    skyHorizon: "#ccd8e0",
    sunStrength: 0.95,
    sunGlow: 0.32,
    sunGlowColor: "#fff0d8",
    sunSize: 1.4,
    moonOpacity: 0,
    starOpacity: 0,
    cloudOpacity: 0.46,
    cloudColor: "#fffdf8",
    cloudDetail: 0.64,
    cloudCoverRange: [0.44, 0.6],
    cloudCover: 0.52,
    atmosphere: 0.6,
    waterColor: "#03170e",
    waterSunColor: "#fff6e8",
    waterDim: 0.66,
    specular: 0.2,
    distortionScale: 3.9,
    waterSunFollow: 0.48,
    lightA: 0.98,
    lightB: 0.8,
    fogColor: "#dfe6ea",
    fogNear: 6000,
    fogFar: 14000,
    fogStrength: 0.2,
    background: "#a8c6de",
    sunAnchor: { x: 0.84, y: 0.31 },
  },

  // 日落：低角度暖光，海面反光明显
  sunset: {
    skyTop: "#5a76a0",
    skyMid: "#c09070",
    skyHorizon: "#f2c08e",
    sunStrength: 1.0,
    sunGlow: 0.6,
    sunGlowColor: "#ffb878",
    sunSize: 1.5,
    moonOpacity: 0,
    starOpacity: 0,
    cloudOpacity: 0.52,
    cloudColor: "#f0c8a0",
    cloudDetail: 0.85,
    cloudCoverRange: [0.36, 0.5],
    cloudCover: 0.43,
    atmosphere: 0.7,
    waterColor: "#0a1810",
    waterSunColor: "#ffaa70",
    waterDim: 0.72,
    specular: 0.18,
    distortionScale: 3.9,
    waterSunFollow: 0.7,
    lightA: 0.78,
    lightB: 0.62,
    fogColor: "#d8a888",
    fogNear: 4600,
    fogFar: 13000,
    fogStrength: 0.85,
    background: "#c09a78",
    sunAnchor: { x: 0.78, y: 0.42 },
  },

  // 黄昏：余晖，紫粉调
  dusk: {
    skyTop: "#0b1124",
    skyMid: "#4a2f45",
    skyHorizon: "#8a4f5e",
    sunStrength: 0.42,
    sunGlow: 0.55,
    sunGlowColor: "#c0708a",
    sunSize: 1.0,
    moonOpacity: 0,
    starOpacity: 0.06,
    cloudOpacity: 0.34,
    cloudColor: "#6b4a5e",
    cloudDetail: 0.4,
    cloudCoverRange: [0.42, 0.56],
    cloudCover: 0.49,
    atmosphere: 0.62,
    waterColor: "#040c14",
    waterSunColor: "#9a6a86",
    waterDim: 0.55,
    specular: 0.13,
    distortionScale: 4,
    waterSunFollow: 0.3,
    lightA: 0.55,
    lightB: 0.42,
    fogColor: "#301f36",
    fogNear: 4200,
    fogFar: 13000,
    fogStrength: 1,
    background: "#241530",
    sunAnchor: { x: 0.74, y: 0.5 },
  },

  // 夜晚：保持原有夜间观感
  night: {
    skyTop: "#01040a",
    skyMid: "#020a15",
    skyHorizon: "#0a2033",
    sunStrength: 0,
    sunGlow: 0,
    sunGlowColor: "#7a6a88",
    sunSize: 0.8,
    moonOpacity: 1,
    starOpacity: 1,
    cloudOpacity: 0.60,
    cloudColor: "#2e4a66",
    cloudDetail: 0.62,
    cloudCoverRange: [0.26, 0.36],
    cloudCover: 0.31,
    atmosphere: 0.15,
    waterColor: "#020a12",
    waterSunColor: "#8aa4c2",
    waterDim: 0.46,
    specular: 0.1,
    distortionScale: 4.1,
    waterSunFollow: 0.35,
    lightA: 0.42,
    lightB: 0.32,
    fogColor: "#0a2033",
    fogNear: 4200,
    fogFar: 13000,
    fogStrength: 1,
    background: "#01040a",
    sunAnchor: { x: 0.95, y: 0.62 },
  },
};

// 时段边界。首尾都落在 deepNight，保证 24 小时循环连续。
const TIMELINE: { hour: number; key: PeriodKey }[] = [
  { hour: 0, key: "deepNight" },
  { hour: 4, key: "preDawn" },
  { hour: 5.5, key: "dawn" },
  { hour: 6.5, key: "sunrise" },
  { hour: 8, key: "morning" },
  { hour: 11, key: "noon" },
  { hour: 14, key: "afternoon" },
  { hour: 17, key: "sunset" },
  { hour: 19, key: "dusk" },
  { hour: 20.5, key: "night" },
  { hour: 24, key: "deepNight" },
];

const parseHex = (hex: string): [number, number, number] => {
  const v = hex.replace("#", "");
  const full =
    v.length === 3
      ? v
          .split("")
          .map((c) => c + c)
          .join("")
      : v;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
};

const toHex = (r: number, g: number, b: number) =>
  "#" +
  [r, g, b]
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");

const mixHex = (a: string, b: string, t: number) => {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const A = parseHex(a);
  const B = parseHex(b);
  return toHex(
    A[0] + (B[0] - A[0]) * t,
    A[1] + (B[1] - A[1]) * t,
    A[2] + (B[2] - A[2]) * t,
  );
};

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

const mixTheme = (a: SkyTheme, b: SkyTheme, t: number): SkyTheme => ({
  skyTop: mixHex(a.skyTop, b.skyTop, t),
  skyMid: mixHex(a.skyMid, b.skyMid, t),
  skyHorizon: mixHex(a.skyHorizon, b.skyHorizon, t),

  sunStrength: mix(a.sunStrength, b.sunStrength, t),
  sunGlow: mix(a.sunGlow, b.sunGlow, t),
  sunGlowColor: mixHex(a.sunGlowColor, b.sunGlowColor, t),
  sunSize: mix(a.sunSize, b.sunSize, t),

  moonOpacity: mix(a.moonOpacity, b.moonOpacity, t),
  starOpacity: mix(a.starOpacity, b.starOpacity, t),

  cloudOpacity: mix(a.cloudOpacity, b.cloudOpacity, t),
  cloudColor: mixHex(a.cloudColor, b.cloudColor, t),
  cloudDetail: mix(a.cloudDetail, b.cloudDetail, t),
  cloudCoverRange: [
    mix(a.cloudCoverRange[0], b.cloudCoverRange[0], t),
    mix(a.cloudCoverRange[1], b.cloudCoverRange[1], t),
  ],
  // 中间值：真正对外使用的是 sampleSky 里按当天种子重算的那个
  cloudCover: mix(a.cloudCover ?? 0.5, b.cloudCover ?? 0.5, t),
  atmosphere: mix(a.atmosphere, b.atmosphere, t),

  waterColor: mixHex(a.waterColor, b.waterColor, t),
  waterSunColor: mixHex(a.waterSunColor, b.waterSunColor, t),
  waterDim: mix(a.waterDim, b.waterDim, t),
  specular: mix(a.specular, b.specular, t),
  distortionScale: mix(a.distortionScale, b.distortionScale, t),
  waterSunFollow: mix(a.waterSunFollow, b.waterSunFollow, t),

  lightA: mix(a.lightA, b.lightA, t),
  lightB: mix(a.lightB, b.lightB, t),

  fogColor: mixHex(a.fogColor, b.fogColor, t),
  fogNear: mix(a.fogNear, b.fogNear, t),
  fogFar: mix(a.fogFar, b.fogFar, t),
  fogStrength: mix(a.fogStrength, b.fogStrength, t),

  background: mixHex(a.background, b.background, t),

  sunAnchor: {
    x: mix(a.sunAnchor.x, b.sunAnchor.x, t),
    y: mix(a.sunAnchor.y, b.sunAnchor.y, t),
  },
});

/** 返回该时刻所属时段的键名，用于调试与显示。 */
export const periodAt = (hour: number): PeriodKey => {
  const h = ((hour % 24) + 24) % 24;
  for (let i = 0; i < TIMELINE.length - 1; i++) {
    if (h >= TIMELINE[i].hour && h < TIMELINE[i + 1].hour) {
      return TIMELINE[i].key;
    }
  }
  return "deepNight";
};

// ---- 云量按天随机 ----
// 同一个自然日内取相同的随机种子，所以云量在白天是稳定的（不会闪烁）；
// 换一天才会变，第二天就是另一番云象。
// 用整数哈希而不是 Math.random()，是为了保证同一天任何时候算出来都一致。
let cachedDay = -1;
let cachedJitter = 0;

const dayJitter = (dayIndex: number): number => {
  if (dayIndex === cachedDay) return cachedJitter;
  // splitmix32 风格的雪崩哈希：相邻整数也会被彻底打散。
  // 早先用过较弱的 xorshift 版本，seed=2 与 seed=3 输出只差 0.007，
  // 导致相邻两天云量几乎一样。
  let x = (dayIndex + 0x9e3779b9) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x21f0aaad) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x735a2d97) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  cachedDay = dayIndex;
  cachedJitter = x / 4294967296;
  return cachedJitter;
};

/** 把一个 [min, max] 区间按 daySeed 稳定地映射成一个取值。 */
const pickInRange = (range: [number, number], jitter: number): number => {
  const [lo, hi] = range;
  return lo + (hi - lo) * jitter;
};

/**
 * 按时刻在相邻时段之间做线性插值，返回可直接驱动渲染的主题。
 * @param daySeed 用于云量随机的「天」标识，同一天传入相同值云量才稳定。
 */
export const sampleSky = (hour: number, daySeed = 0): SkyTheme => {
  const h = ((hour % 24) + 24) % 24;
  const jitter = dayJitter(Math.floor(daySeed));

  let base: SkyTheme;
  if (h >= TIMELINE[TIMELINE.length - 2].hour) {
    // 落在最后一个边界之后：直接取末段
    base = SKY_THEMES[TIMELINE[TIMELINE.length - 1].key];
  } else {
    base = SKY_THEMES[TIMELINE[0].key];
    for (let i = 0; i < TIMELINE.length - 1; i++) {
      const start = TIMELINE[i];
      const end = TIMELINE[i + 1];
      if (h >= start.hour && h < end.hour) {
        const span = end.hour - start.hour;
        const t = span > 0 ? (h - start.hour) / span : 0;
        base = mixTheme(SKY_THEMES[start.key], SKY_THEMES[end.key], t);
        break;
      }
    }
  }

  return {
    ...base,
    cloudCover: pickInRange(base.cloudCoverRange, jitter),
  };
};
