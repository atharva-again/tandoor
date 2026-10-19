/** Build an exact-name and `*` wildcard matcher for tool names. */
export function createToolNameMatcher(entries: readonly string[]): (name: string) => boolean {
	const names = new Set(entries.filter((entry) => !entry.includes("*")));
	const patterns = entries
		.filter((entry) => entry.includes("*"))
		.map((entry) => {
			const source = entry
				.split("*")
				.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
				.join(".*");
			return new RegExp(`^${source}$`);
		});
	return (name) => names.has(name) || patterns.some((pattern) => pattern.test(name));
}
