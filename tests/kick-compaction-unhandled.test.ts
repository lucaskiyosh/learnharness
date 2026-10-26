/**
 * C4 (fork audit 2026-10-26): kickCompaction does
 * `void run.finally(...)` with no catch — a compact() rejection from the
 * pre-try region (before `try {` wraps the LLM call) escapes as an
 * unhandled rejection, which terminates the Node process by default (and
 * the Electron main never respawns the server child).
 *
 * The trigger here: a record whose assistant `content` is not iterable —
 * `serializeForSummary` (`for (const b of assistant.content)`) throws
 * BEFORE the try, while the token estimator's guards let the record sail
 * through the kick's own pre-checks.
 *
 * Before the fix: one unhandled rejection. After the fix: the crash is
 * logged, the registry entry clears, and no rejection escapes.
 */
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import fs from "node:fs";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import (the birth-stamp discipline) ─
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-kick-unhandled-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { kickCompaction, compactionInFlight } = await import("../src/server/compaction.ts");
const { newUserMessage } = await import("../src/core/index.ts");
import type { CompactionDeps } from "../src/server/compaction.ts";

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("kickCompaction crash containment (C4)", () => {
	it("a pre-try crash is logged, never an unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
		process.on("unhandledRejection", onUnhandled);
		try {
			// A malformed record: the assistant's `content` is an object,
			// not an array — the estimator guards accept it (the anchor
			// only reads usage; the heuristic only reads strings/arrays),
			// but serializeForSummary throws iterating it.
			const badAssistant = {
				id: "m-bad",
				role: "assistant",
				content: { not: "an array" } as never,
				usage: { totalTokens: 50_000 },
				stopReason: "stop",
				timestamp: 1,
			} as never;
			const record = {
				id: "chat_kick_crash",
				title: "malformed fixture",
				createdAt: "t",
				updatedAt: "t",
				messages: [
					newUserMessage(`m1: ${"x".repeat(100 * 1024)}`),
					badAssistant,
					newUserMessage(`m3: ${"x".repeat(100 * 1024)}`),
					newUserMessage(`m4: ${"x".repeat(100 * 1024)}`),
					newUserMessage(`m5: ${"x".repeat(100 * 1024)}`),
				],
			} as never;

			const deps: CompactionDeps = {
				// No fs needed: the crash happens before any write.
				chatStore: { getChat: () => record } as never,
				engine: { model: { provider: "faux", id: "test" } } as never,
				modelId: "faux:test",
				kind: "teach",
				thresholdTokens: 1,
				systemPromptTokens: 0,
			};

			kickCompaction(() => deps, "chat_kick_crash");
			// Two macrotasks: the finally callback runs, and any rejected
			// derived promise would surface by now.
			await new Promise((resolve) => setTimeout(resolve, 25));

			assert.equal(unhandled.length, 0, "no unhandled rejection may escape the kick");
			assert.equal(compactionInFlight("chat_kick_crash"), false, "the registry entry is cleaned up");
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
