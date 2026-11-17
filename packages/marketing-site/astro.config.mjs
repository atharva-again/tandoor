import { defineConfig } from "astro/config";
import { brand } from "@tandoor/brand";

export default defineConfig({
  site: brand.site,
  output: "static",
});
