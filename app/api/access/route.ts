/**
 * THE LAN ACCESS BOOTSTRAP (fork, audit C6 part 2): the one-time join
 * URL for the family home server (#109). The server boot prints
 *
 *   http://<lan-ip>:3000/api/access?lh_token=<64-hex>
 *
 * and a device that opens it once carries the lh_access httpOnly cookie
 * for every /api/* call afterwards (SSE included — same-origin). The
 * proxy deliberately excludes this route (proxy.ts): it validates the
 * token itself, via the same constant-time comparison the desktop's
 * header channel uses.
 */
import { desktopAPIAuthorized } from "@/src/server";

const ONE_YEAR_SECONDS = 31_536_000;

export async function GET(req: Request): Promise<Response> {
	const token = new URL(req.url).searchParams.get("lh_token") ?? "";
	const valid = token.length > 0 && desktopAPIAuthorized(new Headers({ "x-learnharness-desktop": token }));
	if (!valid) {
		return Response.json({ error: "Invalid access token." }, { status: 403, headers: { "Cache-Control": "no-store" } });
	}
	return new Response(null, {
		status: 302,
		headers: {
			Location: "/",
			"Set-Cookie": `lh_access=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ONE_YEAR_SECONDS}`,
			"Cache-Control": "no-store",
		},
	});
}
