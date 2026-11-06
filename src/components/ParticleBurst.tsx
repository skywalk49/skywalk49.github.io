"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export type ParticleBurstHandle = {
  /** 让一批元素「炸」成粒子飞散 */
  burst: (targets: HTMLElement[]) => void;
};

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  /** 出生时间戳（performance.now） */
  birth: number;
  /** 存活时长 ms */
  ttl: number;
  color: string;
};

/**
 * 全屏粒子层。点击文字时由外部调用 burst()，
 * 在每个字符的包围盒内撒出粒子，向外发散并渐隐。
 *
 * 之所以用 canvas 而不是 DOM 粒子：
 * 一两百个 DOM 节点同时做 transform 动画会明显掉帧，
 * canvas 一次 requestAnimationFrame 就能全部画完。
 */
const ParticleBurst = forwardRef<ParticleBurstHandle>(
  function ParticleBurst(_props, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const particlesRef = useRef<Particle[]>([]);
    const rafRef = useRef<number>(0);
    const runningRef = useRef(false);

    /** 同步画布尺寸到视口，并返回已按 dpr 缩放的 2d 上下文 */
    const getCtx = () => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth;
      const h = window.innerHeight;

      if (
        canvas.width !== Math.round(w * dpr) ||
        canvas.height !== Math.round(h * dpr)
      ) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return ctx;
    };

    const loop = () => {
      const ctx = getCtx();
      if (!ctx) {
        runningRef.current = false;
        return;
      }

      const w = window.innerWidth;
      const h = window.innerHeight;
      ctx.clearRect(0, 0, w, h);

      const now = performance.now();
      const survivors: Particle[] = [];

      for (const p of particlesRef.current) {
        const age = (now - p.birth) / p.ttl;
        if (age >= 1) continue;
        survivors.push(p);

        // 空气阻尼 + 轻微上浮，像被风吹散而不是自由落体
        p.vx *= 0.965;
        p.vy = p.vy * 0.965 - 0.012;
        p.x += p.vx;
        p.y += p.vy;

        const alpha = Math.pow(1 - age, 1.6);
        const size = p.size * (0.35 + alpha * 0.65);
        if (p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20) continue;

        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
      }

      ctx.globalAlpha = 1;
      particlesRef.current = survivors;

      if (survivors.length > 0) {
        rafRef.current = requestAnimationFrame(loop);
      } else {
        runningRef.current = false;
        ctx.clearRect(0, 0, w, h);
      }
    };

    useImperativeHandle(
      ref,
      () => ({
        burst(targets: HTMLElement[]) {
          if (typeof window === "undefined") return;
          // 尊重系统的“减少动态效果”设置：直接不撒粒子，交给外部淡出
          if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
            return;

          const now = performance.now();
          const list = particlesRef.current;

          for (const el of targets) {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;

            const color = window.getComputedStyle(el).color || "#ffffff";
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;

            // 按包围盒面积决定粒子数。上限压到 34：
            // 之前 72 时汉字会有上千颗粒子叠在一起，看起来是一团马赛克而不是消散。
            const area = rect.width * rect.height;
            const count = Math.max(8, Math.min(34, Math.round(area / 52)));

            for (let i = 0; i < count; i++) {
              const px = rect.left + Math.random() * rect.width;
              const py = rect.top + Math.random() * rect.height;

              // 从字形中心向外发散
              const dx = px - cx;
              const dy = py - cy;
              const dist = Math.hypot(dx, dy) || 1;
              const speed = 0.35 + Math.random() * 1.5;

              list.push({
                x: px,
                y: py,
                vx: (dx / dist) * speed + (Math.random() - 0.5) * 0.7,
                vy: (dy / dist) * speed - (0.2 + Math.random() * 0.8),
                // 颗粒要小才像粉末/星屑，大了就是方块
                size: 0.7 + Math.random() * 1.5,
                birth: now + Math.random() * 90,
                ttl: 800 + Math.random() * 900,
                color,
              });
            }
          }

          if (!runningRef.current) {
            runningRef.current = true;
            rafRef.current = requestAnimationFrame(loop);
          }
        },
      }),
      [],
    );

    useEffect(() => {
      return () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        particlesRef.current = [];
        runningRef.current = false;
      };
    }, []);

    return (
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        style={{
          position: "fixed",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          zIndex: 20,
        }}
      />
    );
  },
);

export default ParticleBurst;
