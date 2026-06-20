# Menu Scan — AGENTS.md

## Project

Static landing page (menu digital QR Code) built with Vite. HTML, CSS, Vanilla JS (ES Modules). No framework.

Priorities in order: Correctness → Accessibility → Performance → SEO → Maintainability → UX → Code elegance.

## Quick Start

```bash
npm install
npm run dev           # port 3000
npm run build         # outputs dist/
npm run preview       # preview production build
```

No test runner, no linter, no CI config. Never edit `dist/`.

## Architecture

```
index.html                # all HTML (no templating)
src/styles/main.css       # @imports base, layout, components, animations, responsive
src/scripts/main.js       # ES module — imports & inits 11 modules on DOMContentLoaded
src/locales/              # fr.js (static), en/es/ar.js (lazy loaded)
public/                   # copied verbatim: robots.txt, sitemap.xml, llms.txt
```

## Technology Rules

Allowed: HTML, CSS, Vanilla JS, ES Modules, Vite.

Forbidden unless asked: React, Vue, Angular, Svelte, TypeScript, jQuery, Bootstrap, Tailwind, Sass, Less, PostCSS, CSS-in-JS, UI frameworks, animation libraries, large dependencies.

Prefer native browser APIs. HTML/CSS over JS.

## i18n / Internationalization

- Runtime deps: `i18next` + `i18next-browser-languagedetector`.
- Init order: `initLoader()` runs first, then `await initI18n()` before any other module.
- Translations use `data-i18n`, `data-i18n-placeholder`, `data-i18n-title`, `data-i18n-alt`, `data-i18n-aria-label` attributes.
- Language detection: `localStorage` → `navigator.language` → fallback `'fr'`.
- `changeLanguage(lng)` dispatches `CustomEvent('languagechange', { detail: { language } })`.
- French (`fr.js`) is bundled statically. `en`, `es`, `ar` are lazy-loaded via dynamic `import()`.
- `<html dir>` toggles `rtl` for Arabic, `ltr` otherwise.

## Key Repo Facts

- **Domain**: `https://menuscan.space/` — canonical, OG, hreflang, JSON-LD all use this.
- **Hero CTA** "Commencer maintenant" → `wa.me/212630230803` (WhatsApp, pre-filled message).
- **Navbar CTA** "Commencer — 500 DH" → `#details` (smooth scroll).
- **SVGs** inline in `index.html` (uses `currentColor`). `src/assets/icons/` has standalone copies.
- **JSON-LD** in `<head>`: `Organization`, `Product` (500 MAD, InStock), `FAQPage` (5 items). FAQ also has `itemscope` microdata.
- **hreflang** for `en/`/`es/`/`ar/` are placeholders — do not create translated pages unless asked.
- **Phone mockup** uses `.p-head-title`/`.p-item-name` (spans, not headings) — avoid fake heading hierarchy.
- **`.sr-only-summary`** is visually hidden text for AI crawlers — never remove.
- **Package manager**: npm only (package-lock.json present).
- **Animations disabled on mobile**: All CSS animations (`fadeInUp`, `fadeIn`, `cardSpin`, hover transforms, etc.) are suppressed at `≤768px` via `responsive.css` to avoid mobile display issues. `prefers-reduced-motion: reduce` also disables animations.

## Module Pattern

Each JS module exports exactly one `init*()` function (`initI18n` is `async`, returns `Promise`). Modules are independent — no global state, no hidden coupling. Fail gracefully if target elements missing.

## Decision Making

1. Smallest change wins. 2. Existing code wins. 3. Native APIs win. 4. HTML > JS. 5. CSS > JS. 6. Simplicity > abstraction. 7. Readability > cleverness.

## Refactoring Rules

- Modify smallest amount necessary. Prefer improving over rewriting.
- Do not refactor unrelated files, rename files, change folder structure, or add dependencies.
- No unnecessary abstractions, files, or folders.

## Before Finishing

Verify: builds successfully, no console errors, responsive layout preserved, accessibility preserved, SEO preserved, performance preserved, no dead/duplicated code.
