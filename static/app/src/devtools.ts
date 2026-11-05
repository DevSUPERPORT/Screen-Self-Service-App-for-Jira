/**
 * Development-only audit hooks (never bundled into the Forge build): accessibility and frame timing.
 *
 * @file        static/app/src/devtools.ts
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import axe from 'axe-core';

declare global {
  interface Window {
    __audit: () => Promise<{ id: string; impact: string | null | undefined; help: string; nodes: string[] }[]>;
    __frames: (ms: number) => Promise<{ frames: number; p95: number; worst: number; over16: number; over33: number }>;
  }
}

window.__audit = async () => {
  const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
  return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 4).map((n) => n.target.join(' ')) }));
};

window.__frames = (ms) => new Promise((resolve) => {
  const deltas: number[] = [];
  let last = performance.now();
  const end = last + ms;
  const tick = (t: number) => {
    deltas.push(t - last);
    last = t;
    if (t < end) requestAnimationFrame(tick);
    else {
      const s = [...deltas].sort((a, b) => a - b);
      resolve({ frames: deltas.length, p95: Math.round(s[Math.floor(s.length * 0.95)] * 10) / 10, worst: Math.round(s[s.length - 1]), over16: deltas.filter((d) => d > 17.5).length, over33: deltas.filter((d) => d > 34).length });
    }
  };
  requestAnimationFrame(tick);
});
