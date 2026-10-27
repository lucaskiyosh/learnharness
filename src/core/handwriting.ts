/**
 * THE HANDWRITING CONTRACT (math pad V1, fork 2026-10-27): the math pad
 * is an INPUT MODALITY — the recognized expression lands in the answer's
 * existing text/thinking fields, exactly like dictation's finals. This
 * module is the pure seam: the stroke contract, the Mathpix wire format,
 * and the response read. The RECOGNIZER IS SWAPPABLE BY DESIGN (the
 * architecture ruling): the adapter behind `HandwritingRecognizer` is
 * the only thing that knows Mathpix exists — a future MyScript or
 * vision-model adapter implements the same three functions and nothing
 * else changes.
 *
 * V1 scope (the product rulings): ONE expression per recognition — the
 * Mathpix strokes API omits `latex_styled` when the input holds more
 * than one line (its own docs recommend one expression per request), so
 * the parse reads the clean LaTeX when present and falls back to the
 * MMD `text` with its math delimiters stripped. Strokes NEVER PERSIST —
 * only the confirmed LaTeX and its provenance ride the answer record.
 *
 * PURE, browser-safe (no fs, no network — the route does the calling).
 */

// ─── the stroke contract ─────────────────────────────────────────────────────

/** One captured stroke: parallel x/y coordinate arrays (canvas-space
 *  points, integers — the wire format the recognizer takes). */
export interface CapturedStroke {
	x: number[];
	y: number[];
}

/** The wire payload every recognizer receives. */
export interface HandwritingStrokes {
	strokes: CapturedStroke[];
}

/** Hard bounds (the 512KB request limit with huge headroom): a single
 *  expression is a few hundred points; thousands mean a runaway pointer
 *  event or a whole page of writing — refused before it costs a request. */
export const HANDWRITING_MAX_STROKES = 256;
export const HANDWRITING_MAX_POINTS_PER_STROKE = 512;
export const HANDWRITING_MAX_TOTAL_POINTS = 4000;

/** Validate a stroke payload off the wire (the route's 400 gate).
 *  Shape-strict, never guesses: paired arrays, equal lengths, finite
 *  integers, and the bounds above. */
export function validateStrokes(input: unknown): { ok: true; strokes: HandwritingStrokes } | { ok: false; error: string } {
	if (typeof input !== "object" || input === null) return { ok: false, error: "strokes must be an object" };
	const raw = input as { strokes?: unknown };
	if (!Array.isArray(raw.strokes) || raw.strokes.length === 0) {
		return { ok: false, error: "strokes.strokes must be a non-empty array" };
	}
	if (raw.strokes.length > HANDWRITING_MAX_STROKES) {
		return { ok: false, error: `too many strokes (${raw.strokes.length} > ${HANDWRITING_MAX_STROKES})` };
	}
	const strokes: CapturedStroke[] = [];
	let total = 0;
	for (const entry of raw.strokes) {
		if (typeof entry !== "object" || entry === null || !Array.isArray((entry as CapturedStroke).x) || !Array.isArray((entry as CapturedStroke).y)) {
			return { ok: false, error: "each stroke must carry x and y arrays" };
		}
		const { x, y } = entry as CapturedStroke;
		if (x.length !== y.length) return { ok: false, error: "stroke x/y arrays must be the same length" };
		if (x.length < 2) return { ok: false, error: "each stroke needs at least 2 points" };
		if (x.length > HANDWRITING_MAX_POINTS_PER_STROKE) {
			return { ok: false, error: `a stroke exceeds ${HANDWRITING_MAX_POINTS_PER_STROKE} points` };
		}
		for (let i = 0; i < x.length; i++) {
			const xi = x[i]!;
			const yi = y[i]!;
			if (!Number.isFinite(xi) || !Number.isFinite(yi)) {
				return { ok: false, error: "stroke coordinates must be finite numbers" };
			}
		}
		total += x.length;
		strokes.push({ x: [...x], y: [...y] });
	}
	if (total > HANDWRITING_MAX_TOTAL_POINTS) {
		return { ok: false, error: `too many points total (${total} > ${HANDWRITING_MAX_TOTAL_POINTS})` };
	}
	return { ok: true, strokes: { strokes } };
}

// ─── the Mathpix adapter's pure halves ──────────────────────────────────────

/** The v3/strokes request body (the adapter's transform — the ONLY code
 *  that knows Mathpix's wire shape). `improve_mathpix: false` is the
 *  privacy-first default (their metadata control: the learner's strokes
 *  are not used to improve their models). */
export function strokesToMathpixBody(strokes: HandwritingStrokes): Record<string, unknown> {
	return {
		strokes: {
			strokes: {
				x: strokes.strokes.map((s) => s.x),
				y: strokes.strokes.map((s) => s.y),
			},
		},
		metadata: { improve_mathpix: false },
	};
}

/** One recognition result — recognizer-agnostic (the UI contract). */
export interface HandwritingRecognition {
	/** The clean LaTeX expression to confirm/edit. */
	latex: string;
	/** The recognizer's estimated probability the reading is 100%
	 *  correct, when it reports one — drives the review hint. */
	confidence?: number;
	/** The raw multi-format text, when the recognizer also returns one
	 *  (Mathpix's MMD `text`) — shown only in the confirm card's raw
	 *  fallback; never persisted. */
	rawText?: string;
}

/** The swappable seam (the architecture ruling): strokes in, recognized
 *  expression out. The server route is THE adapter implementation
 *  (Mathpix); a future adapter swaps in behind the same signature. */
export type HandwritingRecognizer = (strokes: HandwritingStrokes) => Promise<HandwritingRecognition>;

/** Mathpix response read (the adapter's parse, pure for tests): prefer
 *  `latex_styled` — its docs guarantee it is OMITTED when the input is
 *  more than one line (or a table/diagram), in which case `text` (MMD)
 *  carries the content; strip the math delimiters for a fillable string.
 *  Neither present → null (the route 422s honestly). */
export function latexFromMathpixResponse(res: unknown): HandwritingRecognition | null {
	if (typeof res !== "object" || res === null) return null;
	const r = res as { latex_styled?: unknown; text?: unknown; confidence?: unknown };
	if (typeof r.latex_styled === "string" && r.latex_styled.trim().length > 0) {
		return {
			latex: r.latex_styled.trim(),
			confidence: typeof r.confidence === "number" ? r.confidence : undefined,
			rawText: typeof r.text === "string" ? r.text : undefined,
		};
	}
	if (typeof r.text === "string" && r.text.trim().length > 0) {
		return {
			latex: stripMathDelimiters(r.text).trim(),
			confidence: typeof r.confidence === "number" ? r.confidence : undefined,
		};
	}
	return null;
}

/** Strip Mathpix's inline `\( … \)` and block `\[ … \]` delimiters (the
 *  multi-line fallback still carries math inside them; the editable
 *  field wants the bare expression). */
export function stripMathDelimiters(text: string): string {
	return text
		.replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner: string) => inner.trim())
		.replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner: string) => inner.trim());
}

/** Join a recognized expression onto a field's current text (the
 *  dictation-final discipline: never clobber what the learner already
 *  typed — a space between, nothing when either side is empty). */
export function joinHandwriting(current: string, latex: string): string {
	const a = current.trimEnd();
	const b = latex.trim();
	if (a.length === 0) return b;
	if (b.length === 0) return a;
	return `${a} ${b}`;
}

/** The provenance that rides QuestionAnswerData (the ruling: provenance
 *  WITHOUT strokes — the record stays lean, the recognizer stays
 *  swappable, and the tutor learns the answer was written by hand). */
export interface HandwritingProvenance {
	/** The expression the learner confirmed (post-edit). */
	latex: string;
	/** The recognizer's reported confidence, when it reported one. */
	confidence?: number;
	/** True when the learner corrected the recognized reading before
	 *  confirming — the honest signal that the raw recognition was off. */
	corrected?: boolean;
}
