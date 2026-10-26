/**
 * C2 (fork audit 2026-10-26): the turn-less routes read the record, then
 * `await req.json()`, then validate and write against the STALE snapshot.
 * A turn settling inside that window (persistTurn) can be erased by the
 * route's whole-array save.
 *
 * Before the fix: the dismiss route writes [...staleChat.messages,
 * appends] — the settled turn's messages vanish. After the fix: the route
 * re-reads under the update seam, so both the turn content and the
 * dismissal persist.
 *
 * The interleave is deterministic: the request body is a stream the test
 * only completes after persistTurn has landed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import (the birth-stamp discipline) ─
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-turnless-settle-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { persistTurn } = await import("../src/server/turn-service.ts");
const { newUserMessage, dismissedAnswer, newMessageId } = await import("../src/core/index.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const QUIZ_CALL_ID = "call-c2-race";
const OTHER_CALL_ID = "call-c2-other";

/** A record whose newest assistant message poses an unanswered quiz. */
function chatWithDanglingQuiz(): string {
	const chat = chatStore.createChat("turnless x settle race");
	chatStore.updateChat(chat.id, (fresh) => ({ ...fresh, messages: [
		newUserMessage("teach me something"),
		{
			id: newMessageId(),
			role: "assistant",
			content: [
				{ type: "text", text: "Quick check:" },
				{ type: "toolCall", id: QUIZ_CALL_ID, name: "quiz", arguments: { question: "What is a cyclic group?" } },
			],
		} as never,
	] }));
	return chat.id;
}

describe("dismiss x settle race (C2)", () => {
	it("a turn settling during the route's body parse survives the dismiss write", async () => {
		const chatId = chatWithDanglingQuiz();
		const dismissRoute = await import("../app/api/chats/[id]/dismiss/route.ts");

		// A request whose body never completes until the test says so —
		// the route reads the record, then blocks inside req.json().
		let completeBody!: () => void;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				completeBody = () => {
					controller.enqueue(new TextEncoder().encode(JSON.stringify({
						input: { type: "dismiss", toolCallId: QUIZ_CALL_ID, answer: dismissedAnswer("quiz", "What is a cyclic group?") },
					})));
					controller.close();
				};
			},
		});
		const pending = dismissRoute.POST(
			new Request(`http://test/api/chats/${chatId}/dismiss`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
				// undici streaming bodies need duplex; the DOM RequestInit
				// type predates it — a narrow, honest cast.
				duplex: "half",
			} as RequestInit & { duplex: "half" }),
			{ params: Promise.resolve({ id: chatId }) },
		);

		// Let the route run its pre-await steps and enter req.json().
		await new Promise((resolve) => setImmediate(resolve));

		// The turn settles inside the window: persistTurn appends the
		// turn's own messages (a non-question tool result) to the record.
		persistTurn(chatStore, chatId, 0, [
			{
				role: "toolResult",
				toolCallId: OTHER_CALL_ID,
				toolName: "web_fetch",
				content: [{ type: "text", text: "the settled turn's own content" }],
				isError: false,
			} as never,
		], false);
		assert.ok(
			(chatStore.getChat(chatId)!.messages as Array<{ toolCallId?: string }>).some((m) => m.toolCallId === OTHER_CALL_ID),
			"the turn content is on disk before the route writes",
		);

		// The body completes; the route validates against whatever it read
		// BEFORE the settle and writes.
		completeBody();
		const res = await pending;
		assert.equal(res.status, 200, "the question still dangles in both snapshots — the route accepts");

		const messages = chatStore.getChat(chatId)!.messages as Array<{ role?: string; toolCallId?: string }>;
		assert.ok(
			messages.some((m) => m.toolCallId === OTHER_CALL_ID),
			"the settled turn's content survives the dismiss write",
		);
		assert.ok(
			messages.some((m) => m.role === "toolResult" && m.toolCallId === QUIZ_CALL_ID),
			"the dismissal itself also landed",
		);
	});
});
