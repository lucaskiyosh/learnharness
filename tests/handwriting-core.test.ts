/**
 * THE HANDWRITING CONTRACT (math pad V1, fork 2026-10-27): the pure
 * halves — stroke validation, the Mathpix wire transform, the response
 * read (including the documented `latex_styled`-omitted multi-line
 * fallback), the field join — and the provenance flow through
 * buildAnswer/compactAnswerForModel (the answer record carries it; the
 * model sees the handwritten marker).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	HANDWRITING_MAX_STROKES,
	joinHandwriting,
	latexFromMathpixResponse,
	stripMathDelimiters,
	strokesToMathpixBody,
	validateStrokes,
	type CapturedStroke,
} from "../src/core/index.ts";
import { buildAnswer, compactAnswerForModel, type AnswerRequest, type QuestionData } from "../src/core/index.ts";

const stroke = (n: number): CapturedStroke => ({
	x: Array.from({ length: n }, (_, i) => i * 5),
	y: Array.from({ length: n }, () => 10),
});

describe("validateStrokes (the route's 400 gate)", () => {
	it("accepts a well-formed payload and copies it", () => {
		const checked = validateStrokes({ strokes: [stroke(4), stroke(3)] });
		assert.ok(checked.ok);
		assert.equal(checked.strokes.strokes.length, 2);
	});

	it("refuses the malformed shapes honestly", () => {
		assert.equal(validateStrokes(null).ok, false);
		assert.equal(validateStrokes({}).ok, false);
		assert.equal(validateStrokes({ strokes: [] }).ok, false);
		assert.equal(validateStrokes({ strokes: [{ x: [1, 2] }] }).ok, false, "missing y");
		const unpaired = validateStrokes({ strokes: [{ x: [1, 2, 3], y: [1, 2] }] });
		assert.ok(!unpaired.ok && unpaired.error.includes("same length"));
		const short = validateStrokes({ strokes: [{ x: [1], y: [1] }] });
		assert.ok(!short.ok && short.error.includes("2 points"));
		const nonFinite = validateStrokes({ strokes: [{ x: [1, Infinity], y: [1, 2] }] });
		assert.ok(!nonFinite.ok && nonFinite.error.includes("finite"));
	});

	it("enforces the runaway bounds before a request costs anything", () => {
		const tooManyStrokes = validateStrokes({ strokes: Array.from({ length: HANDWRITING_MAX_STROKES + 1 }, () => stroke(3)) });
		assert.ok(!tooManyStrokes.ok && tooManyStrokes.error.includes("too many strokes"));
		const long = validateStrokes({ strokes: [{ x: Array.from({ length: 600 }, (_, i) => i), y: Array.from({ length: 600 }, (_, i) => i) }] });
		assert.ok(!long.ok && long.error.includes("points"));
	});
});

describe("strokesToMathpixBody (the adapter's only Mathpix knowledge)", () => {
	it("wraps in the wire shape and pins the privacy default", () => {
		const body = strokesToMathpixBody({ strokes: [stroke(3), stroke(4)] }) as {
			strokes: { strokes: { x: number[][]; y: number[][] } };
			metadata: { improve_mathpix: boolean };
		};
		assert.deepEqual(body.strokes.strokes.x, [[0, 5, 10], [0, 5, 10, 15]]);
		assert.deepEqual(body.strokes.strokes.y, [[10, 10, 10], [10, 10, 10, 10]]);
		assert.deepEqual(body.metadata, { improve_mathpix: false }, "strokes are not used to improve their models");
	});
});

describe("latexFromMathpixResponse (the documented read)", () => {
	it("prefers the clean latex_styled and carries confidence", () => {
		const parsed = latexFromMathpixResponse({ latex_styled: "3 x^{2}", text: "\\( 3 x^{2} \\)", confidence: 0.93 });
		assert.deepEqual(parsed, { latex: "3 x^{2}", confidence: 0.93, rawText: "\\( 3 x^{2} \\)" });
	});

	it("falls back to text with the math delimiters stripped when latex_styled is omitted (their multi-line rule)", () => {
		const parsed = latexFromMathpixResponse({ text: "\\( a+b \\) and \\[ c \\]", confidence: 0.7 });
		assert.ok(parsed);
		assert.equal(parsed!.latex, "a+b and c");
		assert.equal(parsed!.confidence, 0.7);
	});

	it("returns null when neither is readable — never guesses", () => {
		assert.equal(latexFromMathpixResponse({}), null);
		assert.equal(latexFromMathpixResponse({ latex_styled: "  ", text: "" }), null);
		assert.equal(latexFromMathpixResponse("nonsense"), null);
	});
});

describe("stripMathDelimiters + joinHandwriting", () => {
	it("strips inline and block delimiters", () => {
		assert.equal(stripMathDelimiters("\\(x+1\\)"), "x+1");
		assert.equal(stripMathDelimiters("\\[a\\] \\(b\\)"), "a b");
	});
	it("joins like dictation finals — never clobbers", () => {
		assert.equal(joinHandwriting("", "x^2"), "x^2");
		assert.equal(joinHandwriting("so ", "x^2"), "so x^2");
		assert.equal(joinHandwriting("x^2", ""), "x^2");
	});
});

describe("the provenance flow (QuestionAnswerData.handwriting)", () => {
	const qd = {
		kind: "ask",
		question: "Give an example.",
		options: [{ label: "Other", value: "other" }],
		mode: "text",
	} as unknown as QuestionData;

	it("buildAnswer carries the confirmed provenance onto the record", () => {
		const req: AnswerRequest = {
			text: "\\frac{1}{2}",
			handwriting: { latex: "\\frac{1}{2}", confidence: 0.91, corrected: true },
		};
		const answer = buildAnswer(qd, req);
		assert.equal(answer.text, "\\frac{1}{2}");
		assert.deepEqual(answer.handwriting, { latex: "\\frac{1}{2}", confidence: 0.91, corrected: true });
	});

	it("absent provenance stays absent (no migration for pre-pad answers)", () => {
		const answer = buildAnswer(qd, { text: "plain typed answer" });
		assert.equal(answer.handwriting, undefined);
	});

	it("the model sees the handwritten marker — not a duplicate of the expression", () => {
		const compact = compactAnswerForModel({
			...buildAnswer(qd, { text: "x^2", handwriting: { latex: "x^2" } }),
		});
		assert.equal(compact.handwritten, true);
		assert.equal(compact.text, "x^2", "the expression itself is the text — no copy under another key");
		const plain = compactAnswerForModel(buildAnswer(qd, { text: "x^2" }));
		assert.equal("handwritten" in plain, false);
	});
});
