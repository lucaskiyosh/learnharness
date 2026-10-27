/**
 * THE MATH-PAD RECOGNITION ROUTE (V1, fork 2026-10-27): strokes in,
 * recognized LaTeX out — the Mathpix adapter behind the core's
 * swappable `HandwritingRecognizer` seam.
 *
 * The STT precedent holds exactly (app/api/stt/token): the Mathpix
 * app id + app key live SERVER-SIDE ONLY (auth.json / .env.local via
 * keyValue — the renderer never holds them), and the browser calls
 * this origin-pinned route instead of the provider. Recognition fires
 * ON CONFIRM, not per pointer event (the product ruling: one request
 * per submitted expression — cost and simplicity).
 *
 * Honesty discipline (the route's own law): 503 with the keyless
 * message when the pair is absent, 400 for a malformed stroke payload,
 * 413 for a runaway one (the bounds live in core/handwriting), 502
 * with the provider's own slice when Mathpix rejects or is
 * unreachable. Nothing is ever guessed.
 */
import {
	latexFromMathpixResponse,
	strokesToMathpixBody,
	validateStrokes,
} from "@/src/core";
import { keyValue } from "@/src/server";

const MATHPIX_STROKES_URL = "https://api.mathpix.com/v3/strokes";

export async function POST(req: Request): Promise<Response> {
	const appId = keyValue("MATHPIX_APP_ID");
	const appKey = keyValue("MATHPIX_APP_KEY");
	if (!appId || !appKey) {
		return Response.json(
			{ message: "No MATHPIX_APP_ID/MATHPIX_APP_KEY — add them to auth.json (desktop) or .env.local (dev)." },
			{ status: 503 },
		);
	}

	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ message: "Invalid JSON body" }, { status: 400 });
	}
	const checked = validateStrokes(body);
	if (!checked.ok) {
		return Response.json({ message: checked.error }, { status: 400 });
	}

	try {
		const res = await fetch(MATHPIX_STROKES_URL, {
			method: "POST",
			headers: {
				app_id: appId,
				app_key: appKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(strokesToMathpixBody(checked.strokes)),
		});
		if (!res.ok) {
			const detail = await res.text();
			return Response.json(
				{ message: `Mathpix recognition failed (${res.status}): ${detail.slice(0, 200)}` },
				{ status: 502 },
			);
		}
		const parsed = latexFromMathpixResponse(await res.json());
		if (!parsed) {
			// latex_styled AND text both absent (their docs: neither is
			// guaranteed) — an honest "could not read this", never a guess.
			return Response.json(
				{ message: "Mathpix returned no readable expression — try writing one expression, a bit larger." },
				{ status: 422 },
			);
		}
		return Response.json(parsed);
	} catch {
		return Response.json({ message: "Mathpix unreachable" }, { status: 502 });
	}
}
