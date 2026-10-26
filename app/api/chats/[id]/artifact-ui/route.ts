/**
 * THE ARTIFACT-UI ROUTE (owner, 2026-10-07): POST /api/chats/:id/artifact-ui
 * persists the learner's invert switch onto a demo/figure steer message
 * (details.ui.inverted) so it survives session navigation and restarts.
 * Modeled on the dismissal route's SILENCE: no wake, no agent, no tokens,
 * no SSE — the record is the only state that moves, and the client already
 * holds the toggled state optimistically (no refetch churn).
 *
 * Guards: 404 unknown chat, 400 for a bad body or a non-artifact message
 * id. The target check runs INSIDE the update seam's patch (fork audit
 * C2): the `await req.json()` window can span a turn's settle persist, so
 * both the validation and the write see the fresh record — a settle can no
 * longer be erased by this route, and a toggle can no longer validate
 * against a message a settle already moved.
 */
import { ChatInputError, setSteerUiInverted, type SteerDetails } from "@/src/core";
import { getChat, stores } from "@/src/server";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	if (!getChat(id)) return Response.json({ error: "Unknown chat" }, { status: 404 });

	const body = (await req.json().catch(() => null)) as { input?: unknown } | null;
	const input = body?.input as { messageId?: unknown; inverted?: unknown } | null | undefined;
	if (
		!input ||
		typeof input !== "object" ||
		typeof input.messageId !== "string" ||
		typeof input.inverted !== "boolean"
	) {
		return Response.json({ error: "input must be { messageId: string, inverted: boolean }" }, { status: 400 });
	}
	const messageId = input.messageId;
	const inverted = input.inverted;

	try {
		stores.chatStore.updateChat(id, (record) => {
			// Honesty: the target must actually be a demo/figure steer — checked
			// against the fresh record, inside the atomic patch.
			const target = record.messages.find((m) => m.id === messageId);
			const details = target ? ((target as { details?: unknown }).details as Partial<SteerDetails> | undefined) : undefined;
			if (!details || (details.kind !== "demo" && details.kind !== "visual")) {
				throw new ChatInputError("No demo/figure steer with that message id");
			}
			return { ...record, messages: setSteerUiInverted(record.messages, messageId, inverted) };
		});
	} catch (err) {
		if (err instanceof ChatInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
	return Response.json({ ok: true });
}
