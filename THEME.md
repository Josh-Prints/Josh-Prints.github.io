# Voxprints design theme

Reference doc for matching the site's existing visual design when building
or editing any page. Paste this file into a new session (or just point
Claude at this repo — it's checked in at the root) when you need a new page
or component to look like it belongs on voxprints.com.

## Brand

- **Name:** Voxprints — a 3D-printing storefront. "Vox" = voxel.
- **Logo:** `logo.svg` — an isometric cube built from diamond/hexagon
  facets in three blue shades (`#5fa8ff` top faces, `#2d6fd9` left faces,
  `#1b4fa8` right faces), reading as a 3D-printed voxel block.
- **Overall aesthetic:** clean, minimal, GitHub-Primer-inspired dashboard
  look. System UI fonts, subtle 1px borders, generous whitespace, a single
  blue accent color, no decorative gradients or heavy shadows. Every page
  supports light and dark mode via the same mechanism (below).
- **`<title>` convention:** `"Page purpose — Voxprints"` (e.g. `Browse
  designs — Voxprints`), or just `Voxprints` for the homepage.

## Color system

The palette is GitHub Primer's light/dark colors. Two equivalent variable
naming conventions are used across the codebase — pick whichever one is
already used on the page you're editing; use the `--bg`/`--ink` set for new
pages unless matching a `--canvas`/`--fg` page:

| Role | `--bg` family (order.html, admin/*, order-form.html) | `--canvas` family (index.html, browse.html, estimate.html) | Light value | Dark value |
|---|---|---|---|---|
| Page background | `--bg` | `--canvas` | `#f6f8fa` | `#0d1117` |
| Raised surface (cards, modals) | `--bg-raised` | `--canvas-inset` *(inverted meaning — see note)* | `#ffffff` | `#161b22` |
| Primary text | `--ink` | `--fg` | `#1f2328` | `#e6edf3` |
| Secondary/muted text | `--ink-dim` | `--fg-muted` | `#656d76` (or `#59636e`) | `#8b949e` |
| Accent (links, primary actions, focus) | `--accent` | `--accent` | `#0969da` | `#4493f8` |
| Accent, low-opacity fill | `--accent-dim` | `--accent-subtle` | `#0969da1f` | `#4493f826` |
| Success | `--ok` | `--green` | `#1a7f37` | `#3fb950` |
| Warning | `--warn` | — | `#9a6700` | `#e3b341` |
| Error | `--err` | — | `#cf222e` | `#f85149` |
| Button hover background | `--btn-hover-bg` | `--btn-hover-bg` | `#eef1f4` / `#f3f4f6` | `#21262d` |
| Border tint (for `rgba(var(--border-tint),alpha)`) | `--border-tint` | `--border-tint` | `31,35,40` | `255,255,255` |
| Default border radius | `--radius` | — | `6px` | `6px` |

**Note on `--canvas-inset`:** on the `--canvas` family of pages it's used
for *recessed* panels (slightly off-white/off-black), not raised cards —
those pages use plain `--canvas` + a border for cards instead. Don't
conflate it with `--bg-raised`.

Borders are almost never a flat hex — they're `rgba(var(--border-tint),
0.10–0.18)` so the same rule works in both themes. Typical alphas: `0.10`
subtle divider, `0.12–0.15` card border, `0.18` interactive border.

## Typography

Two font stacks, used consistently by role — don't mix them up:

- **UI text** (headings, body copy, buttons, labels):
  `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`
- **Data / IDs / code-like values** (order IDs, timestamps, status text in
  some contexts, anything that reads as "system output"):
  `ui-monospace, 'SF Mono', 'Roboto Mono', monospace`

`h1` is typically `font-weight: 700`, `font-size: 28px`, with an accent-
colored `<span>` for emphasis (e.g. `Your <span>order</span>`).

## Theme switching (light/dark)

Every page uses the same mechanism — copy it verbatim for a new page:

1. An inline `<script>` in `<head>`, before any stylesheet, reads
   `localStorage.getItem('theme')` and sets `document.documentElement
   .setAttribute('data-theme', t)` if present — this prevents a flash of
   the wrong theme on load:
   ```html
   <script>(function(){try{var t=localStorage.getItem('theme');if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
   ```
2. CSS defines the light values on `:root`, then overrides for dark via
   **both**:
   - `@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){ ... } }` (system preference, unless explicitly overridden)
   - `:root[data-theme="dark"]{ ... }` (explicit user override, works regardless of system preference)
3. A `.theme-switch` toggle control (where present) writes the chosen value
   back to `localStorage.theme` and sets the attribute.

## Radius, shadow, motion

- **Border radius scale:** `6px` default (`var(--radius)`), `8px`/`10px`
  for slightly larger cards/buttons, `12px` for modals, `50%` for circular
  elements (avatars, dots, icon buttons).
- **Shadows** are soft and sparing: cards get a hover lift
  `box-shadow: 0 4px 16px rgba(31,35,40,0.08)`; modals/dropdowns get
  `0 10px 30px rgba(31,35,40,0.16)` (or a side-only shadow for slide-in
  panels, e.g. `-12px 0 30px rgba(31,35,40,0.14)`). Inputs on focus get a
  colored ring: `box-shadow: 0 0 0 3px rgba(9,105,218,0.12)` — not a border
  color change alone.
- **Transitions:** short and snappy. `0.15–0.25s` for most
  hover/focus/toggle transitions, plain `ease`. Playful pop-in elements
  (modals, new chat messages, toggle thumbs) use a bouncy overshoot easing:
  `cubic-bezier(0.34,1.56,0.64,1)`. Smooth reveals (cards fading up on
  scroll, panel open/close) use `cubic-bezier(0.22,1,0.36,1)`.
- Respect `@media (prefers-reduced-motion: reduce)` by collapsing
  animation durations to `0.001ms` on every animated selector — every page
  does this.

## Components

- **`.card`**: `background: var(--bg-raised)`, `border: 1px solid
  rgba(var(--border-tint),0.10)`, `border-radius: var(--radius)`, `padding:
  24px 26px`, `margin-bottom: 18px`. Fades/slides in on load
  (`fadeInUp 0.5s ease both`) and lifts slightly on hover.
- **`.btn-primary`**: solid accent background, white text, border color
  `rgba(var(--border-tint),0.15)`.
- **Status pills** (order status badges): pill-shaped, low-opacity tinted
  background + matching accent text color, a small colored dot. Status →
  color mapping:
  - `new` → accent (blue)
  - `acknowledged` / `quoted` → warn (amber)
  - `printing` → accent (blue, slightly stronger tint)
  - `completed` / `sold` → ok (green)
  - `cancelled` → muted gray (`--ink-dim` on a neutral tint)
- **Inputs/textareas**: `1px solid rgba(var(--border-tint),0.15–0.18)`,
  `border-radius: 6px`, focus state switches border to `var(--accent)` plus
  the focus-ring box-shadow above.
- **Modals**: centered, `border-radius: 12px`, `max-width: ~340–400px`,
  scale-in from `0.94` with the bouncy easing.

## Applying this to a new page

1. Copy the `:root` block (and its dark-mode mirror) from the closest
   existing page rather than retyping values — `order.html` for the
   `--bg`/`--ink` convention, `index.html` for `--canvas`/`--fg`.
2. Copy the theme-toggle boilerplate script verbatim.
3. Use the UI font stack for copy, the monospace stack for anything
   ID/data-like.
4. Default to `6px` radius, soft shadows, and the two easing curves above —
   don't introduce new shadow/easing values without a reason.
5. Keep borders as `rgba(var(--border-tint), alpha)`, never a flat gray hex,
   so dark mode stays correct for free.

## Icons (no emoji)

The site does not use emoji. All icons come from one sprite, `/icons.svg`
(Lucide icons, ISC license, drawn on a 24px grid with a 2px round-capped
stroke in `currentColor`, so they pick up the surrounding text color and
dark/light mode automatically). Use this exact markup, with the symbol id
as the last part of the `href`:

```html
<svg class="ico" width="1em" height="1em" aria-hidden="true"><use href="/icons.svg#mail"/></svg>
```

- Each page's stylesheet starts with `.ico{ vertical-align:-0.18em; flex-shrink:0; }`.
- The icon scales with `font-size` (1em). Put a space after it before the label.
- Inside a `display:flex`/`inline-flex` container, add a `gap` instead (flex
  containers drop the whitespace between an icon and a text node).
- To add an icon, copy its `<symbol>` from the Lucide package into
  `icons.svg` (same `<g fill="none" stroke="currentColor" ...>` wrapper).
- In JS that sets `textContent`, switch to `innerHTML` and `escapeHtml()` any
  user-supplied text. Plain-text spots (placeholders, `title`, toasts,
  `alert`) cannot hold an SVG, so leave the emoji out there.
- Typographic arrows (`→ ←`), the `◆` keyframe marker and `⇧` key hints are
  plain text and are intentionally kept.
