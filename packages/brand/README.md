# Tandoor Brand

This package is the single source of truth for Tandoor's identity, artwork,
web palette, typography, and favicons. Applications consume it directly;
do not copy its assets or redefine its brand styles in application folders.

## Contents

- `src/index.ts`: typed product name, description, production site URL, and contact.
- `src/styles.css`: the Inter variable font, light/dark color tokens, and
  `.brand-prose` typography. Page layout and component styles stay in apps.
- `assets/tandoor-logo.png`: the original production mascot.
- `assets/tandoor-testing-logo.png`: the testing mascot; do not use it as the
  production identity.
- `assets/tandoor-og.png`: the 1200 × 630 social-sharing card, using the original
  production mascot and Inter typography.
- `assets/favicon.ico`: generated 16px, 32px, and 48px browser icons.
- `assets/favicon-32x32.png`: generated PNG browser icon.
- `assets/apple-touch-icon.png`: generated 180px Apple touch icon.

The mascot's terracotta, cream, and dark teal provide the identity. Reading
surfaces deliberately remain neutral. Use the supplied artwork rather than
redrawing or recoloring it.

## Consumption

Add `"@tandoor/brand": "workspace:*"` to an application's dependencies.

```js
import { brand } from "@tandoor/brand";
```

```css
@import "@tandoor/brand/styles.css";
```

The stylesheet provides `--brand-font-sans` and the semantic color tokens
`--page`, `--text`, `--muted`, `--border`, `--subtle`, and `--focus`. Set
`data-theme="light"`, `"dark"`, or `"system"` on the document element.
System mode uses the browser's preferred color scheme; `light-dark()`
keeps each palette defined once. Add `.brand-prose` to a content container
for the shared heading scale and prose styles.

Bundler-based applications import artwork through
`@tandoor/brand/assets/tandoor-logo.png` and favicon files through the same
export. With Vite, use `?url` when a plain asset URL is needed. Do not
maintain a second application-local `public/` copy.

## Updating icons

After replacing the production logo, install FFmpeg and run from the
repository root:

```sh
pnpm brand:icons
```

The generator crops the source mascot's transparent margins and regenerates
all three icon files in this package. If the source canvas changes, update
the crop in `scripts/generate-icons.mjs`. Commit the generated icons together
with the source change. Generation is explicit, so deployments do not need
FFmpeg.

## Updating the social-sharing card

Run `pnpm brand:og` from the repository root after editing
`scripts/generate-og.mjs`. The generator uses Sharp, the bundled Inter font,
and the original production mascot; no browser or AI generation is needed.
Commit the generated PNG with the source change. Applications should import
it from `@tandoor/brand/assets/tandoor-og.png` rather than copying it.
