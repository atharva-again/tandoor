import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const fontfile = require.resolve("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2");
const assets = new URL("../assets/", import.meta.url);
const width = 1200;
const height = 630;

// Keep the original mascot intact; only crop its transparent margins and resize.
const mascot = await sharp(fileURLToPath(new URL("tandoor-logo.png", assets)))
  .extract({ left: 170, top: 260, width: 960, height: 960 })
  .resize(256, 256)
  .png()
  .toBuffer();

const wordmark = await sharp({
  text: {
    text: '<span foreground="#faf7f0" letter_spacing="-4500">Tandoor</span>',
    font: "Inter Semi-Bold 120",
    fontfile,
    dpi: 72,
    rgba: true,
  },
}).png().toBuffer({ resolveWithObject: true });

const tagline = await sharp({
  text: {
    text: '<span foreground="#bdd0c6">Raw ideas in.</span> <span foreground="#faf7f0">Something magnificent out.</span>',
    font: "Inter 24",
    fontfile,
    dpi: 72,
    rgba: true,
  },
}).png().toBuffer({ resolveWithObject: true });

// One oversized curve gives the centered lockup a distinct silhouette without
// adding copy or ornaments. The original mascot crosses the color boundary.
const backdrop = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs>
      <radialGradient id="ink" cx="50%" cy="0%" r="100%">
        <stop offset="0%" stop-color="#174b43"/>
        <stop offset="100%" stop-color="#092d29"/>
      </radialGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="#faf7f0"/>
    <ellipse cx="600" cy="1058" rx="1020" ry="798" fill="url(#ink)"/>
  </svg>
`);

await sharp(backdrop)
  .composite([
    { input: mascot, left: 472, top: 105 },
    {
      input: wordmark.data,
      left: Math.round((width - wordmark.info.width) / 2),
      top: 416,
    },
    {
      input: tagline.data,
      left: Math.round((width - tagline.info.width) / 2),
      top: 550,
    },
  ])
  .png({ compressionLevel: 9 })
  .toFile(fileURLToPath(new URL("tandoor-og.png", assets)));

console.log(`Generated packages/brand/assets/tandoor-og.png (${width} × ${height})`);
