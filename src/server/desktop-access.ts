import { timingSafeEqual } from "node:crypto";

/** Per-launch desktop HTTP capability. This is not an OS-user malware
 * boundary and is not an OAuth credential. Browser-only mode is unchanged;
 * LAN mode (fork, audit C6) arms the same gate for explicitly-exposed
 * web servers.
 *
 * The capability rides EITHER the desktop's header channel OR the
 * lh_access httpOnly cookie the LAN bootstrap mints — the gate is the
 * single comparison point for both. */
export function desktopAPIAuthorized(
	headers: Headers,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const expected = env.LH_DESKTOP_API_SECRET;
	// LAN mode (LH_BIND=lan, src/server/lan-access.ts) requires the
	// capability always — an exposed bind must never serve open. Plain
	// web/dev stays open on its (loopback, since the fork's C6 fix) bind.
	if (env.LH_DESKTOP_SERVER !== "1" && env.LH_BIND !== "lan" && !expected) return true;
	if (!expected || expected.length < 64) return false;
	const supplied = capabilityOf(headers);
	if (!supplied) return false;
	const actual = Buffer.from(supplied);
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/** The capability from either channel: the trusted window's header, or
 * the LAN join cookie. First match wins; no cookie parsing dependency. */
function capabilityOf(headers: Headers): string | null {
	const header = headers.get("x-learnharness-desktop");
	if (header) return header;
	const cookie = headers.get("cookie");
	if (cookie) {
		const match = cookie.match(/(?:^|;\s*)lh_access=([^\s;]+)/);
		if (match) return match[1]!;
	}
	return null;
}
