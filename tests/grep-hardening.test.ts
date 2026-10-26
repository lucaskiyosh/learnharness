/**
 * GREP HARDENING (fork audit C11): the grep tool compiles model-provided
 * regexes and ran regex.test on FULL lines with the deadline checked only
 * per FILE — a catastrophic-backtracking pattern (accidental or injected
 * via content the agent ingests) could pin the synchronous scan, and the
 * shared event loop with it, far past the 10s budget.
 *
 * Pins the bounded-input contract: patterns are capped, and the match sees
 * at most GREP_MATCH_LINE_CHARS of each line (output truncation stays at
 * 500). This bounds the input surface; a deliberately crafted exponential
 * pattern is a residual that needs RE2/worker isolation — out of this
 * change's scope.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { grepTool } from "../src/agent/tools/grep.ts";
import { GREP_MATCH_LINE_CHARS, GREP_MAX_PATTERN_CHARS } from "../src/agent/tools/fs-shared.ts";

let FIXTURE: string;

async function runText(tool: AgentTool<any>, params: unknown): Promise<string> {
	const result = await tool.execute!("c", params, undefined);
	const first = result.content[0];
	assert.ok(first !== undefined && first.type === "text", "first content part is text");
	return (first as { type: "text"; text: string }).text;
}

before(() => {
	FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), "lh-grep-harden-"));
	fs.mkdirSync(FIXTURE, { recursive: true });
});

after(() => {
	fs.rmSync(FIXTURE, { recursive: true, force: true });
});

describe("grep hardening (C11)", () => {
	it("refuses patterns beyond the cap with an honest error", async () => {
		await assert.rejects(
			runText(grepTool, { pattern: "a".repeat(GREP_MAX_PATTERN_CHARS + 1), path: FIXTURE }),
			/Pattern too long/,
		);
	});

	it("matches only within the first GREP_MATCH_LINE_CHARS of a line", async () => {
		const file = path.join(FIXTURE, "long.txt");
		const near = "x".repeat(GREP_MATCH_LINE_CHARS - 100) + "NEEDLE_NEAR";
		const far = "y".repeat(GREP_MATCH_LINE_CHARS + 500) + "NEEDLE_FAR";
		fs.writeFileSync(file, `${near}\n${far}\n`, "utf-8");

		// NEEDLE_NEAR sits just inside the cap but past the 500-char OUTPUT
		// truncation — assert the line MATCHED (printed as long.txt:1:),
		// not that its full text rides the output.
		const out = await runText(grepTool, { pattern: "NEEDLE_NEAR", path: file });
		assert.match(out, /long\.txt:1:/, "a needle inside the match cap is found");

		const beyond = await runText(grepTool, { pattern: "NEEDLE_FAR", path: file });
		assert.equal(beyond, "No matches found", "a needle past the cap is not matched — bounded input, documented");
	});

	it("a megabyte-long line cannot stretch the scan: the deadline applies inside the file", async () => {
		const file = path.join(FIXTURE, "huge-line.txt");
		fs.writeFileSync(file, `${"z".repeat(2 * 1024 * 1024)}\n`, "utf-8");
		// A plain literal over a 2MB line: bounded input keeps this fast.
		const started = Date.now();
		const out = await runText(grepTool, { pattern: "zzz-nope", path: file });
		const elapsed = Date.now() - started;
		assert.equal(out, "No matches found");
		assert.ok(elapsed < 5_000, `bounded match input keeps the scan quick (${elapsed}ms)`);
	});
});
