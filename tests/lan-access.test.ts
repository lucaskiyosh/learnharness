/**
 * LAN MODE (fork, audit C6 part 2): the family home server (#109).
 * Pins the three pieces: the token boot (mint once, store owner-only,
 * arm the gate), the capability gate's dual channel (header OR the
 * lh_access cookie), and the /api/access bootstrap route (one-time join
 * URL → cookie → redirect; a wrong token is a 403).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import (the birth-stamp discipline) ─
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lan-access-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { ensureLanAccessToken } = await import("../src/server/lan-access.ts");
const { desktopAPIAuthorized } = await import("../src/server/desktop-access.ts");
const { PATHS } = await import("../config.ts");

const SECRET = "a".repeat(64);

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("the LAN token boot", () => {
	it("is a no-op outside LAN mode — plain web/dev stays open", () => {
		assert.equal(ensureLanAccessToken({}), null);
		assert.equal(desktopAPIAuthorized(new Headers(), {}), true, "no flags, no secret → the loopback web default");
	});

	it("mints once, stores owner-only, and is idempotent across boots", () => {
		const env: Record<string, string | undefined> = { LH_BIND: "lan" };
		const token = ensureLanAccessToken(env);
		assert.ok(token && token.length >= 64);
		assert.equal(env.LH_DESKTOP_API_SECRET, token, "the gate's secret is armed");

		const file = path.join(PATHS.data, "lan-access.json");
		const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { token: string };
		assert.equal(raw.token, token, "the token is on disk for the next boot");
		const mode = fs.statSync(file).mode & 0o777;
		assert.equal(mode, 0o600, "the stored token is owner-only");

		// The second boot (fresh env) loads the SAME token — no re-mint.
		const second: Record<string, string | undefined> = { LH_BIND: "lan" };
		assert.equal(ensureLanAccessToken(second), token);
		// An explicit secret always wins (the desktop spawn case).
		assert.equal(ensureLanAccessToken({ LH_BIND: "lan", LH_DESKTOP_API_SECRET: SECRET }), SECRET);
	});
});

describe("the capability gate — header or cookie", () => {
	it("LAN mode requires the capability on every request", () => {
		const env = { LH_BIND: "lan", LH_DESKTOP_API_SECRET: SECRET };
		assert.equal(desktopAPIAuthorized(new Headers(), env), false, "no capability → refused");
		assert.equal(desktopAPIAuthorized(new Headers({ "x-learnharness-desktop": "x".repeat(64) }), env), false, "wrong token → refused");
		assert.equal(desktopAPIAuthorized(new Headers({ "x-learnharness-desktop": SECRET }), env), true, "the header channel still works");
		assert.equal(desktopAPIAuthorized(new Headers({ cookie: `lh_access=${SECRET}` }), env), true, "the cookie channel works");
		assert.equal(desktopAPIAuthorized(new Headers({ cookie: `other=1; lh_access=${SECRET}` }), env), true, "cookie parses mid-header");
		assert.equal(desktopAPIAuthorized(new Headers({ cookie: `lh_access=${"x".repeat(64)}` }), env), false, "wrong cookie → refused");
		assert.equal(desktopAPIAuthorized(new Headers(), { LH_BIND: "lan" }), false, "LAN without a secret fails closed");
	});
});

describe("the /api/access bootstrap route", () => {
	it("a valid token mints the cookie and redirects home; a bad one is a 403", async () => {
		const route = await import("../app/api/access/route.ts");
		process.env.LH_DESKTOP_API_SECRET = SECRET;
		try {
			const ok = await route.GET(new Request("http://test:3000/api/access?lh_token=" + SECRET));
			assert.equal(ok.status, 302);
			assert.equal(ok.headers.get("location"), "/");
			const setCookie = ok.headers.get("set-cookie") ?? "";
			assert.match(setCookie, new RegExp(`lh_access=${SECRET}`));
			assert.match(setCookie, /HttpOnly/);
			assert.match(setCookie, /SameSite=Lax/);

			const bad = await route.GET(new Request("http://test:3000/api/access?lh_token=" + "0".repeat(64)));
			assert.equal(bad.status, 403);
			const none = await route.GET(new Request("http://test:3000/api/access"));
			assert.equal(none.status, 403);
		} finally {
			delete process.env.LH_DESKTOP_API_SECRET;
		}
	});
});
