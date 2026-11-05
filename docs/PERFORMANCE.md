# Performance

## Budget

| Moment | Budget | Measured |
|---|---|---|
| Cold overview load, 1,000 projects / 5,000 screen schemes / 300 workflows, 150 ms Jira latency | < 8 s (Forge hard limit 25 s) | **≈ 3–6 s** projected across runs (`tests/performance.test.ts`) |
| Warm load (same container, ≤ 15 s) | < 2 s | 0.2–1.7 s (30 per-project calls, instance graph cached) |
| Animation frames (production build) | p95 ≤ 17.5 ms (60 fps), no long tasks during transitions | editor open p95 17.3 ms, worst 33 ms, 0 long tasks; split p95 17.1 ms, 0 long tasks |
| Accessibility | 0 axe violations (WCAG 2.2 AA + best practice), light and dark | **0** on overview, assignment, split, editor |

## How the load stays fast

Exclusivity needs the instance-wide usage graph (every screen scheme, ITSS, workflow and workflow scheme).
The loader:
- runs the four instance scans **concurrently**, and pages each one **in parallel** once the first page reports `total`
  (critical path ≈ 34 round-trips instead of ≈ 67 sequential),
- starts project, field-scheme and instance reads together,
- caches the graph for 15 s per warm container and drops it after every write.

## How animations stay at 60 fps

- Components subscribe to exactly the store slice they render (a hover re-renders only the slots it affects).
- No full-page `filter: blur()`; motion uses transform/opacity/clip-path.
- The editor grows out of the clicked card with `clip-path` (content never scaled) and mounts the field palette
  after the open animation.
- `prefers-reduced-motion` disables motion (Framer `MotionConfig reducedMotion="user"` + CSS).

## Next step for very large sites

A persistent usage-graph cache (Forge KVS, chunked) refreshed by a scheduled trigger and invalidated by the app's own
writes would make cold loads independent of instance size.
