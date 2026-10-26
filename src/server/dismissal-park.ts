/**
 * PARKED DISMISSALS (owner, 2026-10-04): ESC-discard while the turn is
 * still working. Mid-turn the STORED record holds no pending question or
 * problem (the turn hasn't persisted — its messages land at settle), so a
 * dismissal arriving now CANNOT validate; the old behavior was a hard 409,
 * which left the learner trapped with a phantom question until the turn
 * died (the GLM practice-loop incident: the only escape was killing the
 * dev server).
 *
 * The park (owner ruling: "server-side park"): the dismiss route, finding
 * a live turn, parks the intent and answers 202; the turn's settle path
 * (chat-handler onFinish, AFTER persistTurn, BEFORE endTurn — the same
 * ordering law that makes turn-settled imply durable truth) applies it
 * against the freshly persisted record. Validation runs at APPLY time
 * against real state: if the dismissed question/problem really is pending
 * there, the dismissal lands exactly as the route would have written it;
 * if it never materialized (the call errored, the model re-posed and
 * answered), the park is dropped silently — the thing the user dismissed
 * no longer exists.
 *
 * Lives on globalThis, NOT a module-level Map — the same Next.js module
 * instance discipline as turn-liveness: the dismiss route and the
 * chat-handler entry must see the SAME registry or the park is written in
 * one world and read in another. Ephemeral by design; one parked
 * dismissal per chat (last write wins — there is one dock, one discard).
 */

import { ChatInputError, dismissAppends, emit } from "../core";
import type { ChatStore } from "../core/ports.ts";

/** The parked dismissal body — exactly the parsed input the dismiss route
 *  accepted ({type:"dismiss", toolCallId, answer} or
 *  {type:"dismiss-problem", problemCallId}). */
export type ParkedDismissal = unknown;

interface LhGlobal {
	__lhParkedDismissals?: Map<string, ParkedDismissal>;
}

function registry(): Map<string, ParkedDismissal> {
	const g = globalThis as typeof globalThis & LhGlobal;
	return (g.__lhParkedDismissals ??= new Map<string, ParkedDismissal>());
}

/** Park (or overwrite) the chat's dismissal intent. Called by the dismiss
 *  route when a turn owns the chat. */
export function parkDismissal(chatId: string, input: ParkedDismissal): void {
	registry().set(chatId, input);
}

/** Take the chat's parked dismissal (removes it). Returns null when
 *  nothing is parked. */
export function takeParkedDismissal(chatId: string): ParkedDismissal | null {
	const parked = registry().get(chatId);
	if (parked === undefined) return null;
	registry().delete(chatId);
	return parked;
}

/** Apply the chat's parked dismissal, if any, against the current record.
 * Runs in the turn's onFinish — between persistTurn and endTurn, so a
 * client reacting to "turn-settled" reads the dismissal already in the
 * record. The append path is the route's own (dismissAppends), validated
 * INSIDE the update seam's patch against the fresh record; a ChatInputError
 * means the dismissed thing never materialized — the park is dropped,
 * silence is the correct outcome. The park is consumed only AFTER a
 * successful write (fork audit C14): the route's 202 promised "will land",
 * so a failed write keeps it for the next settle instead of dropping it.
 * Emits "record-changed" exactly when something was written. */
export function applyParkedDismissal(chatStore: ChatStore, chatId: string): void {
	const parked = registry().get(chatId);
	if (parked === undefined) return;
	if (!chatStore.getChat(chatId)) return;
	try {
		chatStore.updateChat(chatId, (fresh) => {
			const appends = dismissAppends(fresh, parked as Parameters<typeof dismissAppends>[1]);
			return { ...fresh, messages: [...fresh.messages, ...appends] };
		});
		registry().delete(chatId); // consumed by the successful write
		emit("record-changed", { chatId });
	} catch (err) {
		if (err instanceof ChatInputError) {
			registry().delete(chatId); // never materialized — drop
			return;
		}
		throw err; // a write failure keeps the park for the next settle
	}
}

/** Discard the chat's parked dismissal without applying it — the session
 * deletion wind-down (fork audit C14): the registry must not leak entries
 * for chats that no longer exist. */
export function discardParkedDismissal(chatId: string): void {
	registry().delete(chatId);
}
