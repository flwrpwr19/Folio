# Design

<!-- impeccable:design-schema 1 -->

## World

**Ethereal Glass** (Vibe archetype) — OLED-black ground (`rgb(0.02,0.02,0.022)`), two ambient glow
orbs (violet `oklcha(0.62,0.20,285,0.16)` top, emerald `oklcha(0.72,0.15,165,0.11)` bottom-left)
painted as radial-gradient quads on the root. Glass chrome: white 3.5% fills, white 10% hairlines,
`backdrop_blur` on bars and pills. Space Grotesk (variable, OFL, bundled in `app/assets/`) drives
every glyph; `ui-monospace` + `tnum` for numerals. Accent: violet `oklcha(0.68,0.17,290)` —
selection and position only.

## Surfaces

- **Slide (default)** — the photo fills the window; top and bottom scrims (linear gradients to
  black) make chrome readable over bright photos. Caption stack above the tray: name 15/600 +
  meta line (`i of n · WxH · size`, tnum) + a live zoom pill (`LiveText`, updates without
  commits). Frosted tray (blur 14) of mounted 116×74 cells, 2 pt violet ring on selection. Glass
  pills top-right (Index, Open Folder) with nested trailing-arrow circles. GPU camera: wheel pans,
  pinch zooms 1–10×, drag pans — all `tx.live_only()`.
- **Index** — sidebar (224 pt, traffic lights over it, pill eyebrows, active row with accent dot,
  status pinned bottom) + frosted toolbar + **bento hero**: newest photo in a double-bezel shell
  (outer white/3.5% radius 22 + inner radius 15 clip, scrim strip with name/"Newest") beside two
  stat plates (36/700 numerals). Below: grid header (pill + 30/700 folder title + hint) and a
  virtualized grid of double-bezel cells (shell radius 18, photo core radius 12, name + dims
  inside). Columns adapt to the laid-out width (3–9); rune's flex min-size gotcha is handled with
  `.min_w(0.0)` on every fluid image container.

## Tokens

- Ground `rgb(0.02,0.02,0.022)` · stage pure black · glass white 3.5% · hairline white 10%.
- Text 95/58/34% · accent violet, selection only.
- Type: Space Grotesk; wordmark 18/700, hero title 30/700, section numerals 30/700 tnum, cell
  names 11.5/550, metadata 9.5–11/400–550.
- Shadows: soft ambient only (y 4–8, blur 18–30, black 38–40%) — never harsh.
- Motion: `Transition::scale(0.985)` on surface and slide changes; hover/press are paint-only.

## Window

macOS full-size-content chrome; traffic lights at (20, 20) over the sidebar/slide; `.window_drag()`
regions: sidebar, toolbar, slide top strip.

## Anti-goals

No 1px gray outlines as decoration, no harsh drop shadows, no flat untextured grids, no
Inter-as-identity, no dead end-screens, no element that clips at the window edge.
