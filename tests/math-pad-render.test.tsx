/**
 * THE MATH PAD's markup (V1, fork 2026-10-27): the toggle and the draw
 * surface render server-side (renderToStaticMarkup, the repo's render
 * discipline — no DOM library). The confirm card is state-gated behind
 * the recognition flow and is covered by the route/core pins; here we
 * pin what renders at mount: the pen toggle (open + closed) and the
 * canvas surface's controls.
 */
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { MathPadSurface, MathPadToggle } from "../components/math-pad.tsx";
import { createElement } from "react";

describe("MathPadToggle", () => {
	it("renders the pen affordance with its aria state", () => {
		const closed = renderToStaticMarkup(createElement(MathPadToggle, { open: false, onToggle: () => {} }));
		assert.match(closed, /data-testid="math-pad-toggle"/);
		assert.match(closed, /aria-expanded="false"/);
		assert.match(closed, /Write/);

		const open = renderToStaticMarkup(createElement(MathPadToggle, { open: true, onToggle: () => {} }));
		assert.match(open, /aria-expanded="true"/);
		assert.match(open, /Close pad/);
	});
});

describe("MathPadSurface (the draw phase at mount)", () => {
	const html = renderToStaticMarkup(
		createElement(MathPadSurface, { onUse: () => {}, onClose: () => {} }),
	);

	it("carries the canvas and its capture affordances", () => {
		assert.match(html, /data-testid="math-pad-canvas"/);
		assert.match(html, /touch-none/, "pointer events must not scroll on touch");
		assert.match(html, /Write one expression/);
	});

	it("carries the controls, gated on strokes existing", () => {
		assert.match(html, /data-testid="math-pad-recognize"/);
		assert.match(html, /Recognize/);
		assert.match(html, /Undo/);
		assert.match(html, /Clear/);
		assert.match(html, /disabled/, "nothing to recognize with an empty canvas");
	});

	it("the confirm card is not rendered before a recognition", () => {
		assert.ok(!html.includes("math-pad-confirm"), "the confirm card only exists after reading");
		assert.ok(!html.includes("math-pad-preview"));
	});
});
