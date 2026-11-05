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
import { OrbitControls, Sky } from "@react-three/drei";
import { Water } from "three-stdlib";
extend({ Water });

const DAY_START = 6;
const DAY_END = 18;

// Water 内部用一个默认只渲染 layer 0 的镜子相机做反射。
// 把星空/月亮放到 layer 1，可避免它们被镜像进海面反射。
const REFLECTION_EXCLUDED_LAYER = 1;
const REFLECTION_EXCLUDED_MASK = 1 << REFLECTION_EXCLUDED_LAYER;

// 天体在屏幕上的归一化落点（x/y 均为 0~1）。
// 早期用固定世界坐标，竖屏时水平视角收窄到 23°，太阳/月亮会直接跑出画面；
// 改成先定屏幕位置、再反推世界方向，就能保证任何宽高比下都完整可见。
const SKY_ANCHOR = {
  day: { x: 0.87, y: 0.29 },
  night: { x: 0.88, y: 0.13 },
};

// 白天保持原版：光源方向为零向量，水面既无漫反射也无镜面高光。
const NO_SUN_DIRECTION = new THREE.Vector3(0, 0, 0);
const MOON_DISTANCE = 5200;
// 用 sprite 而不是球体：球体偏离视轴时会被透视拉成群圆。
// 实测 1440x900 下长轴比 1.21（视轴夹角 36°，理论 1/cos36°=1.24），肉眼可辨。
// sprite 始终正对屏幕，视角怎么转都是正圆；尺寸取原球体直径 2*85，观感不变。
const MOON_SIZE = 170;
// drei Sky 的太阳盘大小由内部着色器决定，与距离无关；这里取一个足够远的值保持原观感。
const SUN_DISTANCE = 1100;
const FALLBACK_MOON_DIRECTION = new THREE.Vector3(0.3, 0.3, -0.9).normalize();

type WaterMesh = THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;

// 天空穹顶地平线色，同时也是夜间雾色，保证远端海面与天边无缝衔接。
const NIGHT_HORIZON = "#12334f";

const THEME = {
  day: {
    waterColor: new THREE.Color(0x001e0f),
    sunColor: new THREE.Color(0xffffff),
    sunDirection: NO_SUN_DIRECTION.clone(),
    distortionScale: 3.7,
    waterDim: 1,
    specular: 0,
    lightA: 1,
    lightB: 0.8,
    background: "#c6d5e2",
  },
  night: {
    waterColor: new THREE.Color(0x020a12),
    sunColor: new THREE.Color(0x8aa4c2),
    sunDirection: FALLBACK_MOON_DIRECTION.clone(),
    distortionScale: 4.1,
    // 保留足够反射细节以维持纹理，但整体压到夜空之下，避免海面比天更亮。
    waterDim: 0.46,
    specular: 0.1,
    lightA: 0.42,
    lightB: 0.32,
    background: "#01060f",
    fogColor: new THREE.Color(NIGHT_HORIZON),
    fogNear: 4200,
    fogFar: 13000,
  },
};

const toHour = (date: Date) =>
  date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;

const getHourOverride = () => {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("hour");
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? ((value % 24) + 24) % 24 : null;
};

const isNightHour = (hour: number) => hour < DAY_START || hour >= DAY_END;

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
const useSkyDirection = (anchor: { x: number; y: number }) => {
  const camera = useThree((state) => state.camera);
  const width = useThree((state) => state.size.width);
  const height = useThree((state) => state.size.height);

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
    const ndcX = anchor.x * 2 - 1;
    const ndcY = 1 - anchor.y * 2;

    return forwards
      .clone()
      .addScaledVector(right, ndcX * tan * aspect)
      .addScaledVector(up, ndcY * tan)
      .normalize();
  }, [anchor.x, anchor.y, camera, width, height]);
};

const Ocean = ({
  theme,
  animate,
}: {
  theme: (typeof THEME)[keyof typeof THEME];
  animate: boolean;
}) => {
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
      // 水深着色器需开启 fog 才能响应夜间雾；白天 scene.fog 为 null，因此不受影响。
      fog: true,
    };
    const instance = new Water(geom, config as any) as WaterMesh;
    const material = instance.material;

    // 把亮度衰减与镜面项拆开：整体压暗的同时保留月光在水面的高光。
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
    uniforms.waterColor.value.copy(theme.waterColor);
    uniforms.sunColor.value.copy(theme.sunColor);
    uniforms.sunDirection.value.copy(theme.sunDirection).normalize();
    uniforms.distortionScale.value = theme.distortionScale;
    uniforms.uDim.value = theme.waterDim;
    uniforms.uSpecular.value = theme.specular;
  }, [water, theme]);

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
  night,
  animate,
}: {
  night: boolean;
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
      sizes[i] = 2.0 + Math.random() * 3.6;
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
    material.uniforms.uOpacity.value = night ? 1 : 0;
  });

  return (
    <points
      geometry={geometry}
      material={material}
      frustumCulled={false}
      layers-mask={REFLECTION_EXCLUDED_MASK}
    />
  );
};

const Moon = ({ night }: { night: boolean }) => {
  const direction = useSkyDirection(SKY_ANCHOR.night);
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
      visible={night}
    >
      <sprite scale={[780, 780, 1]} layers-mask={REFLECTION_EXCLUDED_MASK}>
        <spriteMaterial
          map={glowTexture}
          transparent
          opacity={0.72}
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
          opacity={0.78}
          depthWrite={false}
          depthTest={false}
          toneMapped={false}
          fog={false}
        />
      </sprite>
    </group>
  );
};

const SkyDome = ({ night, animate }: { night: boolean; animate: boolean }) => {
  const moonDirection = useSkyDirection(SKY_ANCHOR.night);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uOpacity: { value: 0 },
          uTime: { value: 0 },
          uTopColor: { value: new THREE.Color("#01060f") },
          uMidColor: { value: new THREE.Color("#04101f") },
          uHorizonColor: { value: new THREE.Color(NIGHT_HORIZON) },
          // 初值占位，真实方向由下方 effect 写入，避免视口变化时重建材质。
          uMoonDirection: { value: FALLBACK_MOON_DIRECTION.clone() },
        },
        vertexShader: `
          varying vec3 vDirection;

          void main() {
            vDirection = normalize((modelMatrix * vec4(position, 1.0)).xyz);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform float uOpacity;
          uniform float uTime;
          uniform vec3 uTopColor;
          uniform vec3 uMidColor;
          uniform vec3 uHorizonColor;
          uniform vec3 uMoonDirection;
          varying vec3 vDirection;

          void main() {
            vec3 dir = normalize(vDirection);
            float h = clamp(dir.y, 0.0, 1.0);

            vec3 color = mix(uHorizonColor, uMidColor, smoothstep(0.0, 0.28, h));
            color = mix(color, uTopColor, smoothstep(0.22, 0.92, h));

            // 低频云气：让天空有明暗起伏，反射到海面才不是一整块死色。
            // 加入缓慢的时间偏移，云层会朝一个方向缓缓漂移。
            vec2 p = dir.xz / max(dir.y * 0.75 + 0.35, 0.16);
            vec2 drift = vec2(uTime * 0.0042, uTime * 0.0016);
            vec2 q = p + drift;
            float cloud =
              sin(q.x * 1.7 + q.y * 1.1) * 0.34 +
              sin(q.x * 3.9 - q.y * 2.4) * 0.22 +
              sin(q.x * 8.3 + q.y * 6.1) * 0.13 +
              sin(q.x * 17.0 - q.y * 13.0) * 0.07;
            float cloudMask = smoothstep(0.12, 0.92, h * 0.5 + 0.5) * smoothstep(0.0, 0.28, h);
            color += vec3(0.11, 0.15, 0.23) * cloud * cloudMask * 0.9;

            float moonGlow = pow(max(dot(dir, uMoonDirection), 0.0), 10.0);
            color += vec3(0.32, 0.43, 0.66) * moonGlow * 0.34;

            float moonHalo = pow(max(dot(dir, uMoonDirection), 0.0), 3.5);
            color += vec3(0.07, 0.12, 0.22) * moonHalo * 0.2;

            float haze = pow(1.0 - h, 7.0);
            color += vec3(0.04, 0.1, 0.18) * haze;

            float dither = fract(sin(dot(dir.xz, vec2(12.9898, 78.233))) * 43758.5453);
            color += (dither - 0.5) * 0.006;

            gl_FragColor = vec4(color, uOpacity);
          }
        `,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );

  useEffect(() => {
    material.uniforms.uMoonDirection.value.copy(moonDirection);
    material.uniforms.uOpacity.value = night ? 1 : 0;
  }, [material, moonDirection, night]);

  useEffect(() => {
    return () => {
      material.dispose();
    };
  }, [material]);

  useFrame((_state, delta) => {
    if (!night || !animate) return;
    material.uniforms.uTime.value += Math.min(delta, 0.05);
  });

  return (
    <mesh material={material} renderOrder={-10} visible={night}>
      <sphereGeometry args={[14000, 48, 32]} />
    </mesh>
  );
};

// 白天云层：独立的半透明奶白云，缓慢横移，给晴朗天空一点生气。
const DayClouds = ({
  animate,
  sunDirection,
}: {
  animate: boolean;
  sunDirection: THREE.Vector3;
}) => {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uOpacity: { value: 0 },
          // 初值占位，真实方向由下方 effect 写入，避免视口变化时重建材质。
          uSunDirection: {
            value: new THREE.Vector3(0.5, 0.2, -0.8).normalize(),
          },
        },
        vertexShader: `
          varying vec3 vDirection;

          void main() {
            vDirection = normalize((modelMatrix * vec4(position, 1.0)).xyz);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform float uTime;
          uniform float uOpacity;
          uniform vec3 uSunDirection;
          varying vec3 vDirection;

          // 取值稳定的小型伪噪声，避免出现明显的条纹
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
            vec3 dir = normalize(vDirection);
            float h = clamp(dir.y, 0.0, 1.0);

            // 仅在地平线以上铺云
            float skyMask = smoothstep(0.015, 0.16, h);
            // 天顶方向云量减少，避免顶部一块厚重的白云压下来
            skyMask *= 1.0 - smoothstep(0.45, 0.95, h) * 0.72;

            // 投影到云层平面，越靠近地平线越密
            vec2 p = dir.xz / max(dir.y * 0.85 + 0.28, 0.2);
            // 两层不同速度的漂移，形成缓慢流动的层次
            vec2 drift = vec2(uTime * 0.010, uTime * 0.0038);
            float base = fbm(p * 1.15 + drift);
            float detail = fbm(p * 3.1 - drift * 1.6 + vec2(3.7, 1.2));

            float density = base * 0.68 + detail * 0.32;
            // 高度越高越稀薄
            density *= mix(1.0, 0.45, smoothstep(0.1, 0.85, h));
            // 阈值按 fbm 实测分布校准（p50≈0.42, p90≈0.52）
            float cloud = smoothstep(0.40, 0.54, density) * skyMask;

            // 朝向太阳的一侧更亮
            float sunAlign = max(dot(dir, uSunDirection), 0.0);
            vec3 cloudColor = mix(
              vec3(0.93, 0.95, 0.98),
              vec3(1.0, 0.99, 0.96),
              sunAlign * 0.7
            );

            gl_FragColor = vec4(cloudColor, cloud * 0.52 * uOpacity);
          }
        `,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );

  useEffect(() => {
    material.uniforms.uSunDirection.value.copy(sunDirection);
  }, [material, sunDirection]);

  useEffect(() => {
    material.uniforms.uOpacity.value = 1;
    return () => {
      material.dispose();
    };
  }, [material]);

  useFrame((_state, delta) => {
    if (!animate) return;
    material.uniforms.uTime.value += Math.min(delta, 0.05);
  });

  return (
    <mesh material={material} renderOrder={-9}>
      <sphereGeometry args={[13500, 48, 32]} />
    </mesh>
  );
};

const FogSync = ({ night }: { night: boolean }) => {
  const scene = useThree((state) => state.scene);

  useEffect(() => {
    if (!night) {
      scene.fog = null;
      return;
    }

    const fog = new THREE.Fog(
      THEME.night.fogColor.getHex(),
      THEME.night.fogNear,
      THEME.night.fogFar,
    );
    scene.fog = fog;

    return () => {
      scene.fog = null;
    };
  }, [scene, night]);

  return null;
};

const Scene = ({ hourOverride }: { hourOverride: number | null }) => {
  const lightARef = useRef<THREE.PointLight | null>(null);
  const lightBRef = useRef<THREE.PointLight | null>(null);
  const camera = useThree((state) => state.camera);

  const [night, setNight] = useState(false);
  const reducedMotion = useReducedMotion();
  const theme = night ? THEME.night : THEME.day;
  const sunDirection = useSkyDirection(SKY_ANCHOR.day);
  const sunPosition = useMemo(
    () => sunDirection.clone().multiplyScalar(SUN_DISTANCE),
    [sunDirection],
  );

  useEffect(() => {
    camera.layers.enable(REFLECTION_EXCLUDED_LAYER);
  }, [camera]);

  useEffect(() => {
    const update = () => {
      const hour = hourOverride ?? toHour(new Date());
      setNight(isNightHour(hour));
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [hourOverride]);

  useEffect(() => {
    if (lightARef.current) lightARef.current.intensity = theme.lightA;
    if (lightBRef.current) lightBRef.current.intensity = theme.lightB;
  }, [theme, night]);

  return (
    <>
      {night && <color attach="background" args={[theme.background]} />}
      <FogSync night={night} />
      <pointLight ref={lightARef} decay={0} position={[100, 100, 100]} />
      <pointLight ref={lightBRef} decay={0.5} position={[-100, -100, -100]} />
      <group visible={!night}>
        <Sky
          sunPosition={[sunPosition.x, sunPosition.y, sunPosition.z]}
          turbidity={0.1}
        />
      </group>
      <group visible={!night}>
        <DayClouds animate={!reducedMotion} sunDirection={sunDirection} />
      </group>
      <SkyDome night={night} animate={!reducedMotion} />
      <Suspense fallback={null}>
        <Ocean theme={theme} animate={!reducedMotion} />
      </Suspense>
      <Starfield night={night} animate={!reducedMotion} />
      <Moon night={night} />
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

  useEffect(() => {
    setHourOverride(getHourOverride());
  }, []);

  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [0, 5, 100], fov: 55, near: 1, far: 20000 }}
      gl={{ antialias: false, powerPreference: "high-performance" }}
    >
      <AdaptiveCamera />
      <Scene hourOverride={hourOverride} />
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
