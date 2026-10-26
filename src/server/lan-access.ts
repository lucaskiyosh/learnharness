/**
 * LAN MODE (fork, audit C6 part 2 — the #109 home-server use case): run
 * the web server for other devices on the network, safely.
 *
 * The web/dev trust model ("no auth") only holds while the bind stays
 * loopback. LAN mode is an explicit opt-in that turns the same
 * origin-pinned capability gate the packaged desktop uses into a
 * first-class token flow:
 *
 *   npm run start:lan          (LH_BIND=lan + bind 0.0.0.0)
 *
 * On boot the first LAN start mints one 64-hex access token, stores it
 * owner-only (mode 0600, crash-atomic) at data/lan-access.json, and sets
 * LH_DESKTOP_API_SECRET — from then on every /api/* request must carry
 * the capability: the header (the desktop's own channel) or the
 * lh_access httpOnly cookie that GET /api/access?lh_token=… mints. A
 * device joins once by opening the bootstrap URL and is done.
 *
 * Deliberately NOT covered here: user accounts (single-household trust —
 * everyone who holds the token is family), HTTPS (a LAN behind a router;
 * the token never leaves the local network), and the second-process lock
 * (the single-process law is unchanged — one server per data dir).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { PATHS } from "../../config.ts";
import { atomicWriteText } from "../store/atomic-file.ts";

const LAN_TOKEN_FILE = path.join(PATHS.data, "lan-access.json");

/** The first non-internal IPv4 the OS reports — for the bootstrap hint. */
function lanAddressHint(): string {
	for (const infos of Object.values(os.networkInterfaces())) {
		for (const info of infos ?? []) {
			if (info.family === "IPv4" && !info.internal) return info.address;
		}
	}
	return "127.0.0.1";
}

/**
 * Mint (or load) the LAN access token and arm the capability gate. The
 * env override is the seam tests drive; the token rides
 * LH_DESKTOP_API_SECRET — the gate desktop-access.ts already enforces.
 * Returns the token when LAN mode is on, null otherwise (a no-op import).
 */
export function ensureLanAccessToken(env: Record<string, string | undefined> = process.env): string | null {
	if (env.LH_BIND !== "lan") return null;
	if (env.LH_DESKTOP_API_SECRET && env.LH_DESKTOP_API_SECRET.length >= 64) {
		return env.LH_DESKTOP_API_SECRET; // an explicit token wins (the desktop spawn case)
	}
	let token: string | null = null;
	try {
		const parsed = JSON.parse(fs.readFileSync(LAN_TOKEN_FILE, "utf-8")) as { token?: unknown };
		if (typeof parsed.token === "string" && parsed.token.length >= 64) token = parsed.token;
	} catch {
		/* absent or corrupt — mint below */
	}
	if (token === null) {
		token = randomBytes(32).toString("hex");
		try {
			atomicWriteText(LAN_TOKEN_FILE, `${JSON.stringify({ token, createdAt: new Date().toISOString() }, null, "\t")}\n`, 0o600);
			fs.chmodSync(LAN_TOKEN_FILE, 0o600); // the rename must never leave the token world-readable
		} catch (err) {
			// A LAN server that cannot persist its token refuses to start
			// unauthenticated — fail closed, loudly.
			throw new Error(`lan-access: could not store the access token (${String(err)}) — refusing to serve LAN traffic unauthenticated`);
		}
	}
	env.LH_DESKTOP_API_SECRET = token;
	return token;
}

// The boot side effect (the keys.ts fill-gap precedent): minting and the
// console hint happen at barrel import, before the first request is
// served — per process, idempotent.
if (process.env.LH_BIND === "lan") {
	const token = ensureLanAccessToken();
	if (token) {
		const host = lanAddressHint();
		console.info(`[lan] serving the local network — devices join once at: http://${host}:3000/api/access?lh_token=${token}`);
		console.info("[lan] the token is also in data/lan-access.json (owner-only) — keep it in the family.");
	}
}
