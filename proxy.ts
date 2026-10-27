import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";
// The LAN token boot lives HERE (fork, audit C6 part 2): production
// loads route modules lazily, and this proxy 403s every /api/* request
// before any barrel-importing route runs — a boot placed in the server
// barrel would never fire (the token would never be minted and the gate
// would starve closed). The proxy module itself loads when the server
// starts, so the side-effect import below mints (or loads) the token and
// arms LH_DESKTOP_API_SECRET before the first request is classified.
// No-op outside LAN mode (LH_BIND unset → the module's boot guard skips).
import "./src/server/lan-access.ts";

/** Applies to every API method, including SSE and spending/settings routes.
 * No public callback or worker bypass: internal jobs call server functions,
 * and any legitimate self-HTTP request must carry the private capability.
 *
 * THE ACCESS BOOTSTRAP (fork, LAN mode) is the one deliberate exception:
 * /api/access mints the lh_access cookie from a one-time token in the
 * query — it validates the token itself, so the proxy must let it through
 * (the matcher below excludes it).
 */
export function proxy(request: NextRequest) {
	if (!desktopAPIAuthorized(request.headers)) {
		return NextResponse.json(
			{ error: "Desktop API access requires the trusted LearnHarness window." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.next();
}

export const config = { matcher: ["/api/((?!access).*)"] };
