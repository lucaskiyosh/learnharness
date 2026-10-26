/**
 * C1 (fork audit 2026-10-26): a background compaction holds a record
 * snapshot ACROSS its LLM call; a turn-less write (the dismiss route)
 * that lands during the summarize window must survive the marker write.
 *
 * Before the fix: compact() re-appends the marker to the STALE snapshot
 * ([...messages, marker]) and saveMessages replaces the whole array — the
 * learner's dismissal is erased and the dismissed question re-opens.
 * After the fix: the marker write reads the record fresh under the update
 * seam, so BOTH the dismissal and the marker persist.
 *
 * The interleave is deterministic: the injected summarizer resolves only
 * when the test releases it, after the dismiss route's 200 has landed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import (the birth-stamp discipline) ─
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-compaction-dismiss-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { kickCompaction, awaitCompaction, compactionInFlight } = await import("../src/server/compaction.ts");
const { newUserMessage, dismissedAnswer, newMessageId } = await import("../src/core/index.ts");
import type { CompactionDeps } from "../src/server/compaction.ts";
import type { LhMessage } from "../src/core/index.ts";

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const QUIZ_CALL_ID = "call-c1-race";

/** A record far over any test threshold whose newest assistant message
 * poses an unanswered quiz — the state a settle-kick compaction runs
 * against while the learner is ESC-dismissing the question. */
function bigChatWithDanglingQuiz(): string {
	const chat = chatStore.createChat("compaction x dismiss race");
	const big = (label: string): LhMessage => newUserMessage(`${label}: ${"x".repeat(100 * 1024)}`);
	chatStore.saveMessages(chat.id, [
		big("m1"),
		big("m2"),
		{
			id: newMessageId(),
			role: "assistant",
			content: [
				{ type: "text", text: "Quick check:" },
				{ type: "toolCall", id: QUIZ_CALL_ID, name: "quiz", arguments: { question: "What is a cyclic group?" } },
			],
		} as never,
	]);
	return chat.id;
}

describe("compaction x dismiss race (C1)", () => {
	it("a dismissal landing during the summarize window survives the marker write", async () => {
		const chatId = bigChatWithDanglingQuiz();
		const dismissRoute = await import("../app/api/chats/[id]/dismiss/route.ts");

		// A summarizer that stays pending until the test releases it —
		// the compaction holds its record snapshot across this await.
		let release!: () => void;
		const gate = new Promise<void>((done) => { release = done; });
		const deps: CompactionDeps = {
			chatStore,
			engine: { model: { provider: "faux", id: "test", contextWindow: 1_000_000 } } as never,
			modelId: "faux:test",
			kind: "teach",
			thresholdTokens: 40_000,
			systemPromptTokens: 100,
			summarize: async () => {
				await gate;
				return {
					summary: "The learner knows X.",
					usage: { input: 1_000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1_500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
			},
		};

		kickCompaction(() => deps, chatId);
		assert.ok(compactionInFlight(chatId), "the compaction is running");

		// The learner ESC-dismisses the pending quiz while the summary is
		// in flight. No turn is running, so the route takes the direct
		// write path and 200s.
		const res = await dismissRoute.POST(
			new Request(`http://test/api/chats/${chatId}/dismiss`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					input: { type: "dismiss", toolCallId: QUIZ_CALL_ID, answer: dismissedAnswer("quiz", "What is a cyclic group?") },
				}),
			}),
			{ params: Promise.resolve({ id: chatId }) },
		);
		assert.equal(res.status, 200, "the dismissal landed (no turn — direct write)");

		// The summary finishes — the marker write must not erase the dismissal.
		release();
		await awaitCompaction(chatId);

		const record = chatStore.getChat(chatId)!;
		const messages = record.messages as Array<{ role?: string; customType?: string; toolCallId?: string }>;
		const dismissal = messages.find((m) => m.role === "toolResult" && m.toolCallId === QUIZ_CALL_ID);
		const marker = messages.find((m) => m.role === "custom" && m.customType === "compaction");
		assert.ok(dismissal, "the learner's dismissal survives the compaction write");
		assert.ok(marker, "the compaction marker also persisted");
	});
});
