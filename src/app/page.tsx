"use client";
import { useState, useCallback, useRef } from "react";
import Sea from "@/components/Sea";
import SplitText from "@/components/SplitText";
import ParticleBurst, {
  type ParticleBurstHandle,
} from "@/components/ParticleBurst";
import "./page.css";

const App = () => {
  const [finish, setFinish] = useState(false);
  const [hiding, setHiding] = useState(false);
  const onLetterAnimationComplete = useCallback(() => setFinish(true), []);

  const titleChars = useRef<HTMLElement[]>([]);
  const descChars = useRef<HTMLElement[]>([]);
  const burstRef = useRef<ParticleBurstHandle>(null);

  const handleHide = useCallback(() => {
    if (hiding) return;
    setHiding(true);

    // 两个 ref 都要取：desc 是 finish 之后才挂载的，可能为空。
    const targets = [...titleChars.current, ...descChars.current];
    burstRef.current?.burst(targets);

    // 字符本身也淡出 + 轻微放大，和粒子同步，
    // 否则文字会「啪」地消失、只剩粒子凭空出现。
    targets.forEach((el, i) => {
      el.style.transition =
        "opacity 520ms ease-out, transform 520ms ease-out, filter 520ms ease-out";
      el.style.transitionDelay = `${i * 8}ms`;
      el.style.opacity = "0";
      el.style.transform = "scale(1.35) translateY(-6px)";
      el.style.filter = "blur(2px)";
    });

    // 等粒子飞散开、字形基本淡出后再卸载 DOM。
    window.setTimeout(() => setFinish(false), 620);
  }, [hiding]);

  return (
    <>
      {!hiding && (
        <div
          className="user"
          role="button"
          tabIndex={0}
          aria-label="隐藏文字"
          onClick={handleHide}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleHide();
            }
          }}
        >
          <SplitText
            className="text"
            text="周杰"
            charsRef={titleChars}
            onLetterAnimationComplete={onLetterAnimationComplete}
          />
          <br />
          {finish && (
            <SplitText
              className="desc"
              text="流水不争先，争的是滔滔不绝"
              charsRef={descChars}
            />
          )}
        </div>
      )}
      <ParticleBurst ref={burstRef} />
      <Sea />
    </>
  );
};

export default App;
