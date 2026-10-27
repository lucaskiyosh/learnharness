/**
 * THE MATH-PAD RECOGNITION ROUTE (V1, fork 2026-10-27): the Mathpix
 * adapter behind the core seam. Pinned with the network stubbed — the
 * keys ride env-first (keyValue), the request shape is asserted on the
 * stub, and every failure mode answers honestly: 503 keyless, 400
 * malformed, 502 provider-side, 422 unreadable.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import (the birth-stamp discipline) ─
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-handwriting-route-"));
process.env.LH_DATA_DIR = TMP_DATA;

type Post = (req: Request) => Promise<Response>;
let POST: Post;

const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
const realFetch = globalThis.fetch;

function stubFetch(responder: () => Response): void {
	calls.length = 0;
	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
		calls.push({ url: String(url), headers, body: JSON.parse(String(init?.body)) });
		return responder();
	}) as typeof fetch;
}

const json = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const okStrokes = { strokes: [{ x: [10, 20, 30], y: [5, 8, 5] }, { x: [40, 50], y: [9, 2] }] };

describe("POST /api/handwriting/recognize", () => {
	it("503s honestly without the key pair (the message says where to add them)", async () => {
		const route = await import("../app/api/handwriting/recognize/route.ts");
		POST = route.POST;
		delete process.env.MATHPIX_APP_ID;
		delete process.env.MATHPIX_APP_KEY;
		const res = await POST(new Request("http://test/api/handwriting/recognize", {
			method: "POST",
			body: JSON.stringify(okStrokes),
		}));
		assert.equal(res.status, 503);
		assert.match((await res.json()).message, /MATHPIX_APP_ID\/MATHPIX_APP_KEY/);
	});

	it("maps the Mathpix read: keys server-side, the privacy default, latex_styled wins", async () => {
		process.env.MATHPIX_APP_ID = "test-app-id";
		process.env.MATHPIX_APP_KEY = "a".repeat(32);
		stubFetch(() => json(200, { latex_styled: "3 x^{2}", text: "\\( 3 x^{2} \\)", confidence: 0.93 }));
		const res = await POST(new Request("http://test/api/handwriting/recognize", {
			method: "POST",
			body: JSON.stringify(okStrokes),
		}));
		assert.equal(res.status, 200);
		const data = (await res.json()) as { latex: string; confidence?: number };
		assert.equal(data.latex, "3 x^{2}");
		assert.equal(data.confidence, 0.93);

		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.url, "https://api.mathpix.com/v3/strokes");
		assert.equal(calls[0]!.headers.app_id, "test-app-id");
		assert.equal(calls[0]!.headers.app_key, "a".repeat(32), "the app key never rides the browser — the route proxies");
		const body = calls[0]!.body as { strokes: { strokes: { x: number[][]; y: number[][] } }; metadata: { improve_mathpix: boolean } };
		assert.deepEqual(body.strokes.strokes.x, [[10, 20, 30], [40, 50]]);
		assert.deepEqual(body.metadata, { improve_mathpix: false });
	});

	it("falls back to the stripped text when latex_styled is omitted (multi-line input)", async () => {
		stubFetch(() => json(200, { text: "\\( a+b \\)", confidence: 0.6 }));
		const res = await POST(new Request("http://test/api/handwriting/recognize", {
			method: "POST",
			body: JSON.stringify(okStrokes),
		}));
		assert.equal(res.status, 200);
		assert.equal(((await res.json()) as { latex: string }).latex, "a+b");
	});

	it("422s when neither field is readable — never guesses", async () => {
		stubFetch(() => json(200, { version: "x" }));
		const res = await POST(new Request("http://test/api/handwriting/recognize", {
			method: "POST",
			body: JSON.stringify(okStrokes),
		}));
		assert.equal(res.status, 422);
	});

	it("502s with the provider's own slice when Mathpix rejects", async () => {
		stubFetch(() => json(401, { error: "bad key" }));
		const res = await POST(new Request("http://test/api/handwriting/recognize", {
			method: "POST",
			body: JSON.stringify(okStrokes),
		}));
		assert.equal(res.status, 502);
		assert.match((await res.json()).message, /Mathpix recognition failed \(401\)/);
	});

	it("400s a malformed stroke payload before any request is spent", async () => {
		stubFetch(() => json(200, {}));
		const res = await POST(new Request("http://test/api/handwriting/recognize", {
			method: "POST",
			body: JSON.stringify({ strokes: [{ x: [1, 2, 3], y: [1, 2] }] }),
		}));
		assert.equal(res.status, 400);
		assert.equal(calls.length, 0, "no provider call on a bad payload");
	});
});

after(() => {
	globalThis.fetch = realFetch;
	delete process.env.MATHPIX_APP_ID;
	delete process.env.MATHPIX_APP_KEY;
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});
