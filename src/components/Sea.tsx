"use client";

import * as THREE from "three";
import { Suspense, useRef, useMemo, useState, useEffect } from "react";
import {
  Canvas,
  extend,
  useThree,
  useLoader,
  useFrame,
} from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Water } from "three-stdlib";
import { sampleSky, type SkyTheme } from "@/lib/skyTimeline";
extend({ Water });

// Water 内部用一个默认只渲染 layer 0 的镜子相机做反射。
// 把星空/月亮放到 layer 1，可避免它们被镜像进海面反射。
const REFLECTION_EXCLUDED_LAYER = 1;
const REFLECTION_EXCLUDED_MASK = 1 << REFLECTION_EXCLUDED_LAYER;

// 月亮在屏幕上的固定落点（归一化）。
// 早期用固定世界坐标，竖屏时水平视角收窄到 23°，月亮会直接跑出画面；
// 改成先定屏幕位置、再反推世界方向，就能保证任何宽高比下都完整可见。
const MOON_ANCHOR = { x: 0.88, y: 0.13 };

// 天空穹顶半径，需与 SkyDome 的 sphereGeometry 一致，方向解算依赖它。
const DOME_RADIUS = 14000;

// 首个时段（深夜）的主题，用作初始值，避免首帧闪烁。
const INITIAL_THEME = sampleSky(0);

// 白天保持原版：光源方向为零向量，水面既无漫反射也无镜面高光。
const NO_SUN_DIRECTION = new THREE.Vector3(0, 0, 0);
const MOON_DISTANCE = 5200;
// 用 sprite 而不是球体：球体偏离视轴时会被透视拉成群圆。
// 实测 1440x900 下长轴比 1.21（视轴夹角 36°，理论 1/cos36°=1.24），肉眼可辨。
// sprite 始终正对屏幕，视角怎么转都是正圆；尺寸取原球体直径 2*85，观感不变。
const MOON_SIZE = 170;
const FALLBACK_MOON_DIRECTION = new THREE.Vector3(0.3, 0.3, -0.9).normalize();

// 太阳盘中心到边缘的角度余弦。半径约 1.6°，比真实太阳（0.27°）大，
// 为的是在只要几十像素的屏幕上依然看得清楚。
// 0.9999566769 取自 three-stdlib Sky 着色器的 sunAngularDiameterCos，
// 用它作为基准能让太阳盘大小与改版前的 drei Sky 一致（屏幕上约 25px）。
const SUN_BASE_RADIUS =
  Math.acos(0.999956676946448443553574619906976478926848692873900859324);

// 由「相对基准半径的倍数」得到太阳盘的角度余弦阈值。
// sunSize = 1 对应约 1.6° 的角直径，比真实太阳（0.27°）大，为的是在屏幕上看得清。
const sunCosFromSize = (size: number) =>
  Math.cos(SUN_BASE_RADIUS * Math.max(size, 0.05));

type WaterMesh = THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;

const toHour = (date: Date) =>
  date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;

const getHourOverride = () => {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("hour");
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? ((value % 24) + 24) % 24 : null;
};

// 调试用：?seed=1~9 可以强制换一套云，便于预览不同云象。
const getSeedOverride = () => {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("seed");
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.floor(Math.abs(value)) : null;
};

const useReducedMotion = () => {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return reduced;
};

const WORLD_UP = new THREE.Vector3(0, 1, 0);

// 把屏幕归一化落点反推成世界方向。
// 只依赖视口尺寸与相机位置，不跟随相机旋转：用户拖拽视角时天体依然留在世界中，
// 但当窗口变窄、水平视角收小时会自动重算，避免天体被挤出画面。
// 这里用解析式而非 unproject，避免首帧 matrixWorld 尚未更新导致方向错误。
// 天体落到海平线以下时，方向仍照算，但可以据此淡出。
const useSkyDirection = (
  anchor: { x: number; y: number },
  distance: number = DOME_RADIUS,
) => {
  const camera = useThree((state) => state.camera);
  const width = useThree((state) => state.size.width);
  const height = useThree((state) => state.size.height);
  // AdaptiveCamera 用 setLength 原地改相机位置，camera 引用不变。
  // 若只依赖 camera 对象，useMemo 不会重算，天体落点会停在首帧的旧位置
  // （实测月亮从 88% 漂到 91.5%）。这里把相机坐标拆成数值纳入依赖。
  const camX = camera.position.x;
  const camY = camera.position.y;
  const camZ = camera.position.z;
  const ax = anchor.x;
  const ay = anchor.y;

  return useMemo(() => {
    const perspective = camera as THREE.PerspectiveCamera;
    const fov = (perspective.fov ?? 55) * (Math.PI / 180);
    const aspect = width / Math.max(height, 1);

    // 相机朝向原点（与 OrbitControls 的 target 一致）。
    const forwards = perspective.position.clone().negate();
    if (forwards.lengthSq() < 1e-6) forwards.set(0, 0, -1);
    forwards.normalize();

    const right = new THREE.Vector3().crossVectors(forwards, WORLD_UP);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(right, forwards).normalize();

    const tan = Math.tan(fov / 2);
    const ndcX = ax * 2 - 1;
    const ndcY = 1 - ay * 2;

    // 以相机为原点、穿过该屏幕点位的射线方向。
    const ray = forwards
      .clone()
      .addScaledVector(right, ndcX * tan * aspect)
      .addScaledVector(up, ndcY * tan)
      .normalize();

    // 必须求「射线与目标球面（半径 distance）的交点」再取方向，不能用射线方向直接当
    // 世界方向：相机偏离原点 100 个单位，若按无限远处理，落点会系统性偏移。
    // 而且不同天体距离不同（月亮 5200、穹顶 14000），必须各用各的半径，
    // 否则月亮会被推到 91.8% 贴到屏幕右边缘。
    const origin = perspective.position;
    const a = 1;
    const b = 2 * origin.dot(ray);
    const c = origin.dot(origin) - distance * distance;
    const disc = b * b - 4 * a * c;
    const t = disc >= 0 ? (-b + Math.sqrt(disc)) / (2 * a) : distance;

    return origin.clone().addScaledVector(ray, Math.max(t, 1)).normalize();
    // 依赖拆成数值：锚点由时间插值得到，每帧都是新对象，用对象引用会导致无谓重算。
    // camera 也纳入依赖：AdaptiveCamera 会改相机距离，不重算会导致落点漂移。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ax, ay, distance, camera, camX, camY, camZ, width, height]);
};

const Ocean = ({ theme, animate }: { theme: SkyTheme; animate: boolean }) => {
  const waterNormals = useLoader(THREE.TextureLoader, "/waternormals.jpeg");
  waterNormals.wrapS = waterNormals.wrapT = THREE.RepeatWrapping;

  const water = useMemo(() => {
    const geom = new THREE.PlaneGeometry(10000, 10000);
    const config = {
      textureWidth: 1024,
      textureHeight: 1024,
      waterNormals,
      sunDirection: NO_SUN_DIRECTION.clone(),
      sunColor: 0xffffff,
      waterColor: 0x001e0f,
      distortionScale: 3.7,
      // 水深着色器需开启 fog 才能响应雾；无雾时 scene.fog 为 null，因此不受影响。
      fog: true,
    };
    const instance = new Water(geom, config as any) as WaterMesh;
    const material = instance.material;

    // 把亮度衰减与镜面项拆开：整体压暗的同时保留太阳/月亮在水面的高光。
    material.uniforms.uDim = { value: 1 };
    material.uniforms.uSpecular = { value: 0 };
    material.fragmentShader = material.fragmentShader
      .replace(
        "uniform vec3 eye;",
        "uniform vec3 eye;\nuniform float uDim;\nuniform float uSpecular;",
      )
      .replace(
        "vec3 outgoingLight = albedo;",
        "vec3 outgoingLight = albedo * uDim + specularLight * uSpecular;",
      );
    material.needsUpdate = true;
    return instance;
  }, [waterNormals]);

  useEffect(() => {
    const uniforms = water.material.uniforms as any;
    uniforms.waterColor.value.set(theme.waterColor);
    uniforms.sunColor.value.set(theme.waterSunColor);
    uniforms.distortionScale.value = theme.distortionScale;
    uniforms.uDim.value = theme.waterDim;
    uniforms.uSpecular.value = theme.specular;
  }, [water, theme]);

  // 水面高光方向跟随太阳；太阳落到地平线下（或夜间）时退回月亮方向。
  const sunDirection = useSkyDirection(theme.sunAnchor);
  const moonDirection = useSkyDirection(MOON_ANCHOR, MOON_DISTANCE);

  useEffect(() => {
    const uniforms = water.material.uniforms as any;
    const source = theme.sunStrength > 0.01 ? sunDirection : moonDirection;
    // 白天正午不能让水面吃太阳直射，否则海面会明显变白，
    // 与改版前的观感（sunDirection 为零向量）不一致。
    uniforms.sunDirection.value
      .copy(source)
      .multiplyScalar(theme.waterSunFollow);
  }, [
    water,
    theme.sunStrength,
    theme.waterSunFollow,
    sunDirection,
    moonDirection,
  ]);

  useEffect(() => {
    return () => {
      water.geometry.dispose();
      water.material.dispose();
    };
  }, [water]);

  useFrame((_state, delta) => {
    if (!animate) return;
    const uniforms = water.material.uniforms as any;
    uniforms.time.value += Math.min(delta, 0.05);
  });

  return <primitive object={water} rotation-x={-Math.PI / 2} />;
};

const Starfield = ({
  opacity,
  animate,
}: {
  opacity: number;
  animate: boolean;
}) => {
  const geometry = useMemo(() => {
    const count = 650;
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const phases = new Float32Array(count);
    // 每颗星有独立的闪烁频率与幅度，避免整片星空同步呼吸。
    const rates = new Float32Array(count);
    const depths = new Float32Array(count);
    const vector = new THREE.Vector3();

    for (let i = 0; i < count; i++) {
      const radius = 9000 * (0.9 + Math.random() * 0.1);
      const theta = Math.random() * Math.PI * 2;
      const phi = 0.05 + Math.random() * Math.PI * 0.44;
      vector.setFromSphericalCoords(radius, phi, theta);
      positions[i * 3] = vector.x;
      positions[i * 3 + 1] = vector.y;
      positions[i * 3 + 2] = vector.z;
      // 星点半径：原先是 2.0~5.6，乘上 dpr=2 后可达 12px，
      // 在屏幕上是一个个白球而不是星点。收小到 1.0~2.6。
      sizes[i] = 1.0 + Math.random() * 1.6;
      phases[i] = Math.random() * Math.PI * 2;
      // 少数亮星闪得更快更深，整体分布偏慢
      const sparkle = Math.random();
      rates[i] = 0.45 + sparkle * sparkle * 2.2;
      depths[i] = 0.3 + sparkle * 0.62;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
    geo.setAttribute("aRate", new THREE.BufferAttribute(rates, 1));
    geo.setAttribute("aDepth", new THREE.BufferAttribute(depths, 1));
    return geo;
  }, []);

  const material = useMemo(() => {
    const shader = new THREE.ShaderMaterial({
      uniforms: {
        uOpacity: { value: 0 },
        uTime: { value: 0 },
        uPixelRatio: { value: 1 },
      },
      vertexShader: `
                attribute float aSize;
                attribute float aPhase;
                attribute float aRate;
                attribute float aDepth;
                uniform float uTime;
                uniform float uPixelRatio;
                uniform float uOpacity;
                varying float vAlpha;

                void main() {
                    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                    gl_Position = projectionMatrix * mvPosition;

                    float heightFade = smoothstep(0.02, 0.34, normalize(position).y);

                    // 双层正弦叠加，让闪烁不那么规律，更像真实星点
                    float wave =
                        sin(uTime * aRate + aPhase) * 0.68 +
                        sin(uTime * aRate * 2.37 + aPhase * 1.9) * 0.32;
                    float twinkle = 1.0 - aDepth * (0.5 - 0.5 * wave);

                    gl_PointSize = aSize * uPixelRatio * (0.82 + twinkle * 0.3);
                    vAlpha = clamp(twinkle, 0.0, 1.0) * heightFade * uOpacity;
                }
            `,
      fragmentShader: `
                varying float vAlpha;

                void main() {
                    float dist = length(gl_PointCoord - vec2(0.5));
                    float alpha = smoothstep(0.5, 0.0, dist) * vAlpha;
                    if (alpha < 0.002) discard;
                    gl_FragColor = vec4(vec3(0.92, 0.96, 1.0), alpha);
                }
            `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    return shader;
  }, []);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  useFrame((state, delta) => {
    if (animate) material.uniforms.uTime.value += delta;
    material.uniforms.uPixelRatio.value = state.gl.getPixelRatio();
    material.uniforms.uOpacity.value = opacity;
  });

  return (
    <points
      geometry={geometry}
      material={material}
      frustumCulled={false}
      layers-mask={REFLECTION_EXCLUDED_MASK}
      visible={opacity > 0.01}
    />
  );
};

const Moon = ({ opacity }: { opacity: number }) => {
  const direction = useSkyDirection(MOON_ANCHOR, MOON_DISTANCE);
  const position = useMemo(
    () => direction.clone().multiplyScalar(MOON_DISTANCE),
    [direction],
  );

  const glowTexture = useMemo(() => {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const gradient = ctx.createRadialGradient(
        size / 2,
        size / 2,
        0,
        size / 2,
        size / 2,
        size / 2,
      );
      gradient.addColorStop(0, "rgba(226, 238, 255, 0.26)");
      gradient.addColorStop(0.2, "rgba(150, 185, 240, 0.08)");
      gradient.addColorStop(0.5, "rgba(110, 150, 215, 0.02)");
      gradient.addColorStop(1, "rgba(110, 150, 215, 0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }, []);

  const surfaceTexture = useMemo(() => {
    const size = 512;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // 画成圆形贴图：圆外保持透明，否则 sprite 显示为一个方块。
    ctx.save();
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = "#fffdf3";
    ctx.fillRect(0, 0, size, size);

    let seed = 20261104;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };

    for (let i = 0; i < 90; i++) {
      const x = random() * size;
      const y = random() * size;
      const r = 4 + random() * 26;
      const shade = 234 + Math.floor(random() * 16);
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
      gradient.addColorStop(
        0,
        `rgba(${shade}, ${shade - 3}, ${shade - 9}, 0.3)`,
      );
      gradient.addColorStop(1, `rgba(${shade}, ${shade - 3}, ${shade - 9}, 0)`);
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = 0; i < 14; i++) {
      const x = random() * size;
      const y = random() * size;
      const r = 12 + random() * 40;
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
      gradient.addColorStop(0, "rgba(226, 228, 232, 0.14)");
      gradient.addColorStop(1, "rgba(226, 228, 232, 0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }, []);

  useEffect(() => {
    return () => {
      glowTexture.dispose();
      surfaceTexture?.dispose();
    };
  }, [glowTexture, surfaceTexture]);

  return (
    <group
      position={position}
      renderOrder={5}
      layers-mask={REFLECTION_EXCLUDED_MASK}
      visible={opacity > 0.01}
    >
      <sprite scale={[780, 780, 1]} layers-mask={REFLECTION_EXCLUDED_MASK}>
        <spriteMaterial
          map={glowTexture}
          transparent
          opacity={0.72 * opacity}
          depthWrite={false}
          depthTest={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </sprite>
      <sprite
        scale={[MOON_SIZE, MOON_SIZE, 1]}
        renderOrder={6}
        layers-mask={REFLECTION_EXCLUDED_MASK}
      >
        <spriteMaterial
          map={surfaceTexture ?? undefined}
          color={surfaceTexture ? "#ffffff" : "#fffdf3"}
          transparent
          opacity={0.78 * opacity}
          depthWrite={false}
          depthTest={false}
          toneMapped={false}
          fog={false}
        />
      </sprite>
    </group>
  );
};

// 天空穹顶：唯一负责天空渐变、低频云、太阳盘与光晕的组件。
// 早期曾与 drei 的 <Sky> 叠加使用，但 sky 着色器自身也会画一个太阳盘，
// 且它的方向解算（太阳距原点 1100，相机偏移 100）与锚点映射存在视差，
// 两者叠加会出现「两个太阳」。现在统一由这里绘制，只有一个太阳来源。
const SkyDome = ({
  theme,
  moonDirection,
  sunDirection,
  animate,
}: {
  theme: SkyTheme;
  moonDirection: THREE.Vector3;
  sunDirection: THREE.Vector3;
  animate: boolean;
}) => {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uOpacity: { value: 1 },
          uTime: { value: 0 },
          uTopColor: { value: new THREE.Color("#01060f") },
          uMidColor: { value: new THREE.Color("#04101f") },
          uHorizonColor: { value: new THREE.Color("#12334f") },
          uCloudColor: { value: new THREE.Color("#1a3048") },
          uCloudOpacity: { value: 0.5 },
          uCloudDetail: { value: 1 },
          uCloudCover: { value: 0.4 },
          uAtmosphere: { value: 0.5 },
          uMoonDirection: { value: FALLBACK_MOON_DIRECTION.clone() },
          uMoonOpacity: { value: 1 },
          uSunDirection: {
            value: new THREE.Vector3(0.5, 0.2, -0.8).normalize(),
          },
          uSunStrength: { value: 0 },
          uSunInfluence: { value: 0 },
          uSunGlow: { value: 0 },
          uSunGlowColor: { value: new THREE.Color("#ffb070") },
          uSunCos: { value: sunCosFromSize(1) },
          // 云形状的随机偏移：useMemo([]) 只在挂载时跑一次，
          // 所以每次刷新页面换一片「云图」，而页面存续期间偏移固定，
          // 云的形状不会抖。
          uCloudOffset: {
            value: new THREE.Vector2(
              (Math.random() - 0.5) * 2000,
              (Math.random() - 0.5) * 2000,
            ),
          },
        },
        vertexShader: `
          varying vec3 vWorldPosition;

          void main() {
            // 传世界坐标，片元里再减去相机位置。
            // 直接用 normalize(worldPos) 当方向是错的：天球半径 14000，
            // 而相机在 (0,5,100)，两点的方向差异会让天体整体偏移。
            vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform float uOpacity;
          uniform float uTime;
          uniform vec3 uTopColor;
          uniform vec3 uMidColor;
          uniform vec3 uHorizonColor;
          uniform vec3 uCloudColor;
          uniform float uCloudOpacity;
          uniform float uCloudDetail;
          uniform float uCloudCover;
          uniform float uAtmosphere;
          uniform vec3 uMoonDirection;
          uniform float uMoonOpacity;
          uniform vec3 uSunDirection;
          uniform float uSunStrength;
          uniform float uSunInfluence;
          uniform float uSunGlow;
          uniform vec3 uSunGlowColor;
          uniform float uSunCos;
          uniform vec2 uCloudOffset;
          varying vec3 vWorldPosition;

          // ---- 云噪声：与改版前 DayClouds 相同的 4 层 fbm ----
          float hash(vec2 p) {
            return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
          }

          float noise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(
              mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
              mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
              u.y
            );
          }

          float fbm(vec2 p) {
            float value = 0.0;
            float amp = 0.5;
            for (int i = 0; i < 4; i++) {
              value += amp * noise(p);
              p *= 2.07;
              amp *= 0.5;
            }
            return value;
          }

          void main() {
            // 用相机到该点的真实方向，与 drei Sky 的做法一致。
            vec3 dir = normalize(vWorldPosition - cameraPosition);
            float h = clamp(dir.y, 0.0, 1.0);

            // 相机（俯角约 3°）只能看到 h ≲ 0.42 的天空，
            // 渐变必须压缩在这个范围内，否则地平线附近永远是抬不起来发灰的中间色。
            vec3 color = mix(uHorizonColor, uMidColor, smoothstep(0.0, 0.10, h));
            color = mix(color, uTopColor, smoothstep(0.06, 0.40, h));

            // 大气散射：真实天空不是纯径向渐变，而是沿太阳方向偏暖、
            // 背光侧偏冷。这里只做**色相偏移**、不压整体亮度：
            // 早先版本乘了偏暗的 skyCool，结果整片天空被拉灰压暗（实测天顶
            // 亮度只有原版 Sky 的 65%），失去改版前那种明亮朦胧的观感。
            float sunAngle = dot(dir, uSunDirection);
            float scatter = pow(max(sunAngle, 0.0), 2.2);
            // 背光侧：略微偏蓝（+B、-R），保持亮度
            color += vec3(-0.030, 0.004, 0.055) * uAtmosphere * (1.0 - scatter);
            // 向阳侧：略微偏暖（+R、-B），保持亮度
            color += vec3(0.070, 0.030, -0.040) * uAtmosphere * scatter;
            // 太阳低垂时地平线附近出现暖色带
            float tHorizon = pow(1.0 - h, 5.0);
            color += vec3(0.11, 0.06, 0.01) * tHorizon * uAtmosphere;

            // ---- 云层：4 层 fbm，与改版前一致 ----
            float skyMask = smoothstep(0.015, 0.16, h);
            // 天顶云量大幅减少：原版上半部几乎是透过薄纱的天空，
            // 云只轻微改变亮度，不能压出一块灰蓝顶盖。
            skyMask *= 1.0 - smoothstep(0.30, 0.80, h) * 0.78;

            // 投影到云层平面，越靠近地平线越密。
            // uCloudOffset 每次刷新都会变，相当于换一片天空的「云图种子」。
            vec2 p = dir.xz / max(dir.y * 0.85 + 0.28, 0.2) + uCloudOffset;
            // 两层不同速度的漂移，形成缓慢流动的层次
            vec2 drift = vec2(uTime * 0.010, uTime * 0.0038);
            float baseN = fbm(p * 1.15 + drift);
            float detailN = fbm(p * 3.1 - drift * 1.6 + vec2(3.7, 1.2));

            float density = baseN * 0.68 + detailN * 0.32;
            density *= mix(1.0, 0.45, smoothstep(0.1, 0.85, h));
            // 阈值按 fbm 实测分布校准（p50≈0.42, p90≈0.52）。
            // 起点由 uCloudCover 控制：调高 = 云更少，能露出更多蓝天，
            // 而蓝天正是海面反射取色的来源（露不出蓝，海面就会一片惨白）。
            float cloud = smoothstep(uCloudCover, uCloudCover + 0.14, density) * skyMask;

            // 云的明暗：朝向太阳的一侧更亮，背光侧更暗，产生体积感。
            // 注意必须乘 uSunInfluence：否则夜里太阳不发光时，
            // 云仍会被朝太阳方向混成 55% 白色（实测夜间云比天空亮 33 级）。
            float sunAlign = max(sunAngle, 0.0);
            vec3 cloudCol = mix(
              uCloudColor,
              vec3(1.0),
              pow(sunAlign, 1.5) * 0.55 * uSunInfluence
            );
            // 背光侧压暗的幅度受 cloudDetail 控制，白天设得很小以保持通透
            cloudCol = mix(cloudCol, uCloudColor * 0.88, (1.0 - cloud) * uCloudDetail * 0.5);
            color = mix(color, cloudCol, cloud * uCloudOpacity);

            // 太阳光晕：越大范围越柔，pow 指数越高越集中
            float sunDot = max(dot(dir, uSunDirection), 0.0);
            color += uSunGlowColor * pow(sunDot, 8.0) * 0.55 * uSunGlow;
            color += uSunGlowColor * pow(sunDot, 3.0) * 0.22 * uSunGlow;

            // 太阳盘：用角度余弦做阈值，保证任何视角下都是正圆
            float sunDisc = smoothstep(uSunCos, uSunCos + 0.00002, sunDot);
            color = mix(color, vec3(1.0), sunDisc * uSunStrength);

            float moonGlow = pow(max(dot(dir, uMoonDirection), 0.0), 10.0);
            color += vec3(0.32, 0.43, 0.66) * moonGlow * 0.34 * uMoonOpacity;

            float moonHalo = pow(max(dot(dir, uMoonDirection), 0.0), 3.5);
            color += vec3(0.07, 0.12, 0.22) * moonHalo * 0.2 * uMoonOpacity;

            float haze = pow(1.0 - h, 7.0);
            color += vec3(0.04, 0.1, 0.18) * haze * uMoonOpacity;

            float dither = fract(sin(dot(dir.xz, vec2(12.9898, 78.233))) * 43758.5453);
            color += (dither - 0.5) * 0.006;

            gl_FragColor = vec4(color, uOpacity);

            // THREE.Color 的 setStyle() 会把 sRGB 十六进制转成线性值存进 uniform，
            // 而自定义 ShaderMaterial 不会自动做输出编码。少了这一步，
            // 整片天空会明显偏暗（实测 sRGB 188 只输出 128，差 60 级）。
            #include <colorspace_fragment>
          }
        `,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        // 保持 depthTest 开启：穹顶必须被海面正确遮挡。
        // 绘制顺序由 renderOrder = -10 保证（先画天空，再画海面）。
        toneMapped: false,
      }),
    [],
  );

  useEffect(() => {
    const u = material.uniforms;
    u.uTopColor.value.set(theme.skyTop);
    u.uMidColor.value.set(theme.skyMid);
    u.uHorizonColor.value.set(theme.skyHorizon);
    u.uCloudColor.value.set(theme.cloudColor);
    u.uCloudOpacity.value = theme.cloudOpacity;
    u.uCloudDetail.value = theme.cloudDetail;
    u.uCloudCover.value = theme.cloudCover;
    u.uAtmosphere.value = theme.atmosphere;
    u.uSunGlowColor.value.set(theme.sunGlowColor);
    u.uSunStrength.value = theme.sunStrength;
    // 太阳影响力：太阳越亮，云才有理由被照亮；夜间趋近 0
    u.uSunInfluence.value = Math.min(
      1,
      theme.sunStrength * 1.2 + theme.sunGlow * 0.4,
    );
    u.uSunGlow.value = theme.sunGlow;
    u.uSunCos.value = sunCosFromSize(theme.sunSize);

    u.uMoonOpacity.value = theme.moonOpacity;
  }, [material, theme]);

  useEffect(() => {
    material.uniforms.uMoonDirection.value.copy(moonDirection);
    material.uniforms.uSunDirection.value.copy(sunDirection);
  }, [material, moonDirection, sunDirection]);

  useEffect(() => {
    return () => {
      material.dispose();
    };
  }, [material]);

  useFrame((_state, delta) => {
    if (!animate) return;
    // 只有真正可见时才推进时间，省掉不必要的计算。
    if (material.uniforms.uOpacity.value <= 0.001) return;
    material.uniforms.uTime.value += Math.min(delta, 0.05);
  });

  return (
    <mesh material={material} renderOrder={-10} frustumCulled={false}>
      <sphereGeometry args={[DOME_RADIUS, 48, 32]} />
    </mesh>
  );
};

const FogSync = ({ theme }: { theme: SkyTheme }) => {
  const scene = useThree((state) => state.scene);

  useEffect(() => {
    if (theme.fogStrength <= 0.001) {
      scene.fog = null;
      return;
    }

    // 雾强度参与插值：白天为 0 时完全无雾，与改版前观感一致。
    const target = new THREE.Color(theme.fogColor);
    const fog = new THREE.Fog(target.getHex(), theme.fogNear, theme.fogFar);
    scene.fog = fog;

    return () => {
      scene.fog = null;
    };
  }, [scene, theme]);

  return null;
};

const Scene = ({
  hourOverride,
  seedOverride,
}: {
  hourOverride: number | null;
  seedOverride: number | null;
}) => {
  const lightARef = useRef<THREE.PointLight | null>(null);
  const lightBRef = useRef<THREE.PointLight | null>(null);
  const camera = useThree((state) => state.camera);

  const reducedMotion = useReducedMotion();

  // 按当前时刻采样主题。每分钟重算一次即可——插值本身是连续的，
  // 没必要每秒更新，既能保持平滑，又避免不必要的 React 重渲染。
  const [theme, setTheme] = useState<SkyTheme>(INITIAL_THEME);

  useEffect(() => {
    const update = () => {
      const now = new Date();
      const hour = hourOverride ?? toHour(now);
      // daySeed 用「年内第几天」：同一天云量稳定，换一天才换一套云。
      const daySeed =
        seedOverride ??
        (Math.floor(
          (now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) /
            86400000,
        ) ||
          0);
      setTheme(sampleSky(hour, daySeed));
    };
    update();
    const timer = window.setInterval(update, 30_000);
    return () => window.clearInterval(timer);
  }, [hourOverride, seedOverride]);

  const sunDirection = useSkyDirection(theme.sunAnchor);
  const moonDirection = useSkyDirection(MOON_ANCHOR, MOON_DISTANCE);
  useEffect(() => {
    camera.layers.enable(REFLECTION_EXCLUDED_LAYER);
  }, [camera]);

  useEffect(() => {
    if (lightARef.current) lightARef.current.intensity = theme.lightA;
    if (lightBRef.current) lightBRef.current.intensity = theme.lightB;
  }, [theme]);

  return (
    <>
      <color attach="background" args={[theme.background]} />
      <FogSync theme={theme} />
      <pointLight ref={lightARef} decay={0} position={[100, 100, 100]} />
      <pointLight ref={lightBRef} decay={0.5} position={[-100, -100, -100]} />
      <SkyDome
        theme={theme}
        moonDirection={moonDirection}
        sunDirection={sunDirection}
        animate={!reducedMotion}
      />
      <Suspense fallback={null}>
        <Ocean theme={theme} animate={!reducedMotion} />
      </Suspense>
      <Starfield opacity={theme.starOpacity} animate={!reducedMotion} />
      <Moon opacity={theme.moonOpacity} />
    </>
  );
};

const MIN_DISTANCE = 80;
const MAX_DISTANCE = 200;
const DEFAULT_DISTANCE = 100;

const AdaptiveCamera = () => {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);

  useEffect(() => {
    // 窄竖屏水平视角更小，稍拉近以免海平线显得过远；其余情况保持默认距离。
    const aspect = size.width / Math.max(size.height, 1);
    const distance = aspect < 0.85 ? MIN_DISTANCE + 10 : DEFAULT_DISTANCE;
    camera.position.setLength(distance);
    camera.updateProjectionMatrix();
  }, [camera, size.width, size.height]);

  return null;
};

const Sea = () => {
  const [hourOverride, setHourOverride] = useState<number | null>(null);
  const [seedOverride, setSeedOverride] = useState<number | null>(null);

  useEffect(() => {
    setHourOverride(getHourOverride());
    setSeedOverride(getSeedOverride());
  }, []);

  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [0, 5, 100], fov: 55, near: 1, far: 20000 }}
      gl={{ antialias: false, powerPreference: "high-performance" }}
    >
      <AdaptiveCamera />
      <Scene hourOverride={hourOverride} seedOverride={seedOverride} />
      <OrbitControls
        enableZoom
        zoomSpeed={0.35}
        minDistance={MIN_DISTANCE}
        maxDistance={MAX_DISTANCE}
        enablePan={false}
        enableDamping
        dampingFactor={0.08}
        rotateSpeed={0.5}
        target={[0, 0, 0]}
        minPolarAngle={Math.PI * 0.18}
        maxPolarAngle={Math.PI * 0.49}
      />
    </Canvas>
  );
};

export default Sea;
