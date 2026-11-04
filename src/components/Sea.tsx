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

const DAY_SUN_POSITION: [number, number, number] = [500, 150, -1000];
// 白天保持原版：光源方向为零向量，水面既无漫反射也无镜面高光。
const NO_SUN_DIRECTION = new THREE.Vector3(0, 0, 0);
const MOON_DIRECTION = new THREE.Vector3(0.3, 0.3, -0.9).normalize();
const MOON_POSITION = MOON_DIRECTION.clone().multiplyScalar(5200);

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
    sunDirection: MOON_DIRECTION.clone(),
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
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
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
                uniform float uTime;
                uniform float uPixelRatio;
                uniform float uOpacity;
                varying float vAlpha;

                void main() {
                    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                    gl_Position = projectionMatrix * mvPosition;
                    gl_PointSize = aSize * uPixelRatio;

                    float heightFade = smoothstep(0.02, 0.34, normalize(position).y);
                    float twinkle = 0.72 + 0.28 * sin(uTime * 0.7 + aPhase);
                    vAlpha = twinkle * heightFade * uOpacity;
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
      gradient.addColorStop(0, "rgba(226, 238, 255, 0.34)");
      gradient.addColorStop(0.2, "rgba(150, 185, 240, 0.1)");
      gradient.addColorStop(0.5, "rgba(110, 150, 215, 0.025)");
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
      position={MOON_POSITION}
      renderOrder={5}
      layers-mask={REFLECTION_EXCLUDED_MASK}
      visible={night}
    >
      <sprite scale={[780, 780, 1]} layers-mask={REFLECTION_EXCLUDED_MASK}>
        <spriteMaterial
          map={glowTexture}
          transparent
          opacity={1}
          depthWrite={false}
          depthTest={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </sprite>
      <mesh layers-mask={REFLECTION_EXCLUDED_MASK}>
        <sphereGeometry args={[85, 48, 48]} />
        <meshBasicMaterial
          map={surfaceTexture ?? undefined}
          color={surfaceTexture ? "#ffffff" : "#fffdf3"}
          transparent
          opacity={1}
          depthWrite={false}
          depthTest={false}
          toneMapped={false}
          fog={false}
        />
      </mesh>
    </group>
  );
};

const SkyDome = ({ night }: { night: boolean }) => {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uOpacity: { value: 0 },
          uTopColor: { value: new THREE.Color("#01060f") },
          uMidColor: { value: new THREE.Color("#04101f") },
          uHorizonColor: { value: new THREE.Color(NIGHT_HORIZON) },
          uMoonDirection: { value: MOON_DIRECTION.clone() },
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
            vec2 p = dir.xz / max(dir.y * 0.75 + 0.35, 0.16);
            float cloud =
              sin(p.x * 1.7 + p.y * 1.1) * 0.34 +
              sin(p.x * 3.9 - p.y * 2.4) * 0.22 +
              sin(p.x * 8.3 + p.y * 6.1) * 0.13 +
              sin(p.x * 17.0 - p.y * 13.0) * 0.07;
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
    material.uniforms.uOpacity.value = night ? 1 : 0;
    return () => {
      material.dispose();
    };
  }, [material, night]);

  return (
    <mesh material={material} renderOrder={-10} visible={night}>
      <sphereGeometry args={[14000, 48, 32]} />
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
        <Sky sunPosition={DAY_SUN_POSITION} turbidity={0.1} />
      </group>
      <SkyDome night={night} />
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
