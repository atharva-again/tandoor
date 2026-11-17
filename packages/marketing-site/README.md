# Tandoor Marketing Site

This Astro site uses Vite for local development and production builds. It is
designed to be hosted separately from the main `atharvaverma.com` site at
`tandoor.atharvaverma.com`.

## Local development

Use Node.js `22.23.4` or newer, matching Astro's minimum supported version.

From the repository root:

```sh
pnpm site:dev
```

Check the site's Astro pages and TypeScript without building:

```sh
pnpm site:check
```

This also runs as part of the root `pnpm typecheck` and `pnpm check` commands.
The site has its own strict Astro TypeScript configuration and uses
TypeScript 6 because `astro check` does not support the root's TypeScript 7.

Astro serves the site locally and uses Vite under the hood. To make a static
production build (including the site check) and preview it:

```sh
pnpm site:build
pnpm site:preview
```

## Cloudflare Pages

Configure the Pages project with:

- Root directory: repository root
- Build command: `pnpm --filter @tandoor/marketing-site build`
- Build output directory: `packages/marketing-site/dist`
- Node version: `22.23.4` or newer (set `NODE_VERSION=22.23.4`)

Then add `tandoor.atharvaverma.com` as a custom domain in the Pages project.
This should leave the existing `atharvaverma.com` Pages site unchanged.

The pages intended for the OAuth branding form are:

- Homepage: `https://tandoor.atharvaverma.com/`
- Privacy policy: `https://tandoor.atharvaverma.com/privacy/`
- Terms of service: `https://tandoor.atharvaverma.com/terms/`

In Google Auth Platform, add `atharvaverma.com` as an authorized domain and
verify ownership if Google requests it. Set the homepage and privacy policy
URLs above in the Branding settings. Keep these pages public and up to date.

## Favicons

The site consumes logos, favicons, metadata, and typography directly from
`@tandoor/brand`; it does not keep application-local asset copies. See
[`../brand/README.md`](../brand/README.md) for the brand system and icon
regeneration instructions.
