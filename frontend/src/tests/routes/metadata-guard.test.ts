// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getDataDir } from "$lib/server/metadata";

describe("getDataDir vitest guard", () => {
	it("refuses the default data dir fallback under vitest without DATA_DIR", () => {
		const saved = process.env.DATA_DIR;
		delete process.env.DATA_DIR;
		try {
			expect(() => getDataDir()).toThrow(/DATA_DIR must be set explicitly/);
		} finally {
			if (saved !== undefined) process.env.DATA_DIR = saved;
		}
	});
});
