import { describe, expect, it } from "vitest";
import { createToolNameMatcher } from "../src/core/tool-name-matcher.ts";

describe("createToolNameMatcher", () => {
	it("matches exact names and `*` patterns", () => {
		const matches = createToolNameMatcher(["read", "file_*_text"]);

		expect(matches("read")).toBe(true);
		expect(matches("file_12_text")).toBe(true);
		expect(matches("write")).toBe(false);
		expect(matches("file_12_text_extra")).toBe(false);
	});

	it("treats other regular-expression characters literally", () => {
		const matches = createToolNameMatcher(["tool.+*"]);

		expect(matches("tool.+name")).toBe(true);
		expect(matches("toolXname")).toBe(false);
	});
});
