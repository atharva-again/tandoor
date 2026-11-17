import { describe, expect, it } from "vitest";
import { brand } from "./index.js";

describe("brand metadata", () => {
  it("exposes a complete public identity", () => {
    expect(brand.name).toBe("Tandoor");
    expect(brand.description.trim()).not.toBe("");
    expect(new URL(brand.site).protocol).toBe("https:");
    expect(brand.contactEmail).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  });
});
