/**
 * C5 (fork audit 2026-10-26): beginTurn claims the chat's turn registry
 * ~140 lines BEFORE the try{} that compensates failures with endTurn. Any
 * synchronous throw in between (the agent factories, the request-cycle
 construction) escapes uncompensated and locks the chat with 409s until
 * the 30-minute TTL eviction.
 *
 * Before the fix: isTurnRunning stays true after the rejection. After the
 * fix: the gap is wrapped — endTurn fires before the rethrow.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import (the birth-stamp discipline) ─
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agent-construction-"));
process.env.LH_DATA_DIR = TMP_DATA;
// The key-presence turn gate (chat-flow.test.ts precedent): env-first truth.
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { chatStore } = await import("../src/store/chats.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { isTurnRunning, endTurn } = await import("../src/server/turn-liveness.ts");

const created: string[] = [];
after(() => {
	for (const id of created) { try { endTurn(id); } catch { /* idempotent */ } }
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("agent-construction failure releases liveness (C5)", () => {
	it("a buildAgent throw after beginTurn clears the turn registry", async () => {
		const chat = chatStore.createChat("agent construction lock");
		created.push(chat.id);
		// The per-chat model pin — exactly the setup flow's stamp
		// (chat-flow.test.ts's createConfiguredChat discipline).
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });

		await assert.rejects(
			handleChatInput(chat.id, { type: "text", text: "hi" }, () => {
				throw new Error("fixture: agent construction exploded");
			}),
			/fixture: agent construction exploded/,
		);

		assert.equal(isTurnRunning(chat.id), false, "the registry must not hold the chat until the TTL");
	});
});
