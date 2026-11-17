import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Crop the transparent margins around the source mascot, then resize once per size.
const filters = [
  "[0:v]crop=960:960:170:260,split=4[small][medium][large][touch]",
  "[small]scale=16:16:flags=lanczos[ico16]",
  "[medium]scale=32:32:flags=lanczos,split=2[png32][ico32]",
  "[large]scale=48:48:flags=lanczos[ico48]",
  "[touch]scale=180:180:flags=lanczos[apple]",
];

execFileSync(
  "ffmpeg",
  [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", "tandoor-logo.png",
    "-filter_complex", filters.join(";"),
    "-map", "[png32]", "-frames:v", "1", "-update", "1", "favicon-32x32.png",
    "-map", "[apple]", "-frames:v", "1", "-update", "1", "apple-touch-icon.png",
    "-map", "[ico16]", "-map", "[ico32]", "-map", "[ico48]",
    "-c:v", "bmp", "-pix_fmt", "bgra",
    "-frames:v:0", "1", "-frames:v:1", "1", "-frames:v:2", "1",
    "favicon.ico",
  ],
  {
    cwd: fileURLToPath(new URL("../assets/", import.meta.url)),
    stdio: "inherit",
  },
);
