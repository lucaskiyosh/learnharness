"use client";

import { useEffect, useRef, useState } from "react";
import { EraserIcon, Loader2Icon, PencilIcon, Undo2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { latexGlyphHtml } from "@/components/latex-glyph";
import {
	joinHandwriting,
	type CapturedStroke,
	type HandwritingRecognition,
} from "@/src/core";

/**
 * THE MATH PAD (V1, fork 2026-10-27): answer as on paper. An INPUT
 * MODALITY in the dictation sense — the recognized expression lands in
 * the field's existing text via the same ref+state discipline the dock
 * already uses for dictated finals. The pad owns INPUT ONLY; the
 * learning flow (grading, tutoring, adaptation) is untouched.
 *
 * The flow (the product ruling — recognize on confirm, never per
 * pointer event): draw → Recognize (one request: strokes → the server
 * route → Mathpix) → the CONFIRM CARD (the KaTeX-rendered reading, an
 * editable field, the confidence badge) → "Use it" writes the confirmed
 * expression into the target field with its provenance.
 *
 * The canvas is dependency-free (pointer events + a polyline redraw);
 * capture idioms follow Mathpix's own open-source live-drawing demo.
 * Strokes are EPHEMERAL by the persistence ruling — only the confirmed
 * latex + confidence + corrected flag ride the answer record.
 */

// ─── the toggle ───────────────────────────────────────────────────────────────

/** The small pen button in the target field's label row (the mic's
 *  quiet-button sibling). Controlled by the dock — the surface mounts
 *  separately so the layout owns its place. */
export function MathPadToggle({
	open,
	onToggle,
	testid = "math-pad-toggle",
}: {
	open: boolean;
	onToggle: () => void;
	testid?: string;
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-label={open ? "Close the math pad" : "Write the answer by hand"}
			aria-expanded={open}
			data-testid={testid}
			className="flex shrink-0 items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-xs text-muted-foreground/70 transition-colors hover:bg-foreground/5 hover:text-muted-foreground"
		>
			<PencilIcon className="size-3" />
			{open ? "Close pad" : "Write"}
		</button>
	);
}

// ─── the surface ────────────────────────────────────────────────────────────

type PadPhase = "draw" | "recognizing" | "confirm";

export function MathPadSurface({
	onUse,
	onClose,
}: {
	/** The confirmed expression + its provenance — corrected is true when
	 *  the learner edited the recognized reading before confirming. */
	onUse: (latex: string, provenance: { confidence?: number; corrected: boolean }) => void;
	onClose: () => void;
}) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const strokesRef = useRef<CapturedStroke[]>([]);
	const drawingRef = useRef(false);
	const [strokeCount, setStrokeCount] = useState(0); // redraw + render signal
	const [phase, setPhase] = useState<PadPhase>("draw");
	const [recognition, setRecognition] = useState<HandwritingRecognition | null>(null);
	const [latexDraft, setLatexDraft] = useState("");
	const [corrected, setCorrected] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Full polyline redraw on every stroke change (strokes are small;
	// incremental segments ride the move handler below).
	const redraw = () => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		const { width, height } = canvas;
		ctx.clearRect(0, 0, width, height);
		ctx.strokeStyle = "rgb(148 163 184)";
		ctx.lineWidth = 2 * Math.max(1, Math.round((canvas.width || 600) / 600));
		ctx.lineJoin = "round";
		ctx.lineCap = "round";
		for (const s of strokesRef.current) {
			if (s.x.length < 2) continue;
			ctx.beginPath();
			ctx.moveTo(s.x[0]!, s.y[0]!);
			for (let i = 1; i < s.x.length; i++) ctx.lineTo(s.x[i]!, s.y[i]!);
			ctx.stroke();
		}
	};

	// Size the backing store once per mount (dpr-crisp), then redraw.
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
		const w = canvas.clientWidth || 600;
		const h = canvas.clientHeight || 224;
		canvas.width = Math.round(w * dpr);
		canvas.height = Math.round(h * dpr);
		const ctx = canvas.getContext("2d");
		if (ctx) ctx.scale(dpr, dpr);
		redraw();
	}, []);

	const point = (e: React.PointerEvent<HTMLCanvasElement>) => ({
		x: Math.round(e.nativeEvent.offsetX),
		y: Math.round(e.nativeEvent.offsetY),
	});

	const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
		if (phase !== "draw") return;
		e.currentTarget.setPointerCapture(e.pointerId);
		drawingRef.current = true;
		const p = point(e);
		strokesRef.current = [...strokesRef.current, { x: [p.x], y: [p.y] }];
		setStrokeCount(strokesRef.current.length);
	};
	const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
		if (!drawingRef.current) return;
		const p = point(e);
		const stroke = strokesRef.current.at(-1);
		if (!stroke) return;
		stroke.x.push(p.x);
		stroke.y.push(p.y);
		// Incremental: draw just the new segment.
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (ctx && stroke.x.length > 1) {
			const n = stroke.x.length;
			ctx.beginPath();
			ctx.moveTo(stroke.x[n - 2]!, stroke.y[n - 2]!);
			ctx.lineTo(stroke.x[n - 1]!, stroke.y[n - 1]!);
			ctx.stroke();
		}
	};
	const endStroke = () => {
		if (!drawingRef.current) return;
		drawingRef.current = false;
		// A single-point "stroke" (a tap) is noise for recognition — drop it.
		const stroke = strokesRef.current.at(-1);
		if (stroke && stroke.x.length < 2) {
			strokesRef.current = strokesRef.current.slice(0, -1);
			setStrokeCount(strokesRef.current.length);
			redraw();
		}
	};

	const undo = () => {
		if (strokesRef.current.length === 0) return;
		strokesRef.current = strokesRef.current.slice(0, -1);
		setStrokeCount(strokesRef.current.length);
		redraw();
	};
	const clear = () => {
		strokesRef.current = [];
		setStrokeCount(0);
		redraw();
	};

	const recognize = async () => {
		if (strokesRef.current.length === 0 || phase === "recognizing") return;
		setPhase("recognizing");
		setError(null);
		try {
			const res = await fetch("/api/handwriting/recognize", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ strokes: strokesRef.current }),
			});
			const data = (await res.json().catch(() => null)) as
				| (HandwritingRecognition & { message?: string })
				| { message?: string }
				| null;
			if (!res.ok || !data || !("latex" in data) || typeof data.latex !== "string") {
				setError(data?.message ?? `Recognition failed (${res.status}).`);
				setPhase("draw");
				return;
			}
			setRecognition(data);
			setLatexDraft(data.latex);
			setCorrected(false);
			setPhase("confirm");
		} catch {
			setError("The recognition request failed — try again.");
			setPhase("draw");
		}
	};

	const useIt = () => {
		const latex = latexDraft.trim();
		if (latex.length === 0) return;
		onUse(latex, { confidence: recognition?.confidence, corrected });
	};

	// Esc closes the pad — stopPropagation claims it (the keyboard wave's
	// law) so the dock's own Esc chain (dictation stop) does not also fire.
	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			onClose();
		}
	};

	return (
		<div
			data-testid="math-pad-surface"
			onKeyDown={onKeyDown}
			className="mx-2 mt-1 rounded-[8px] border border-border/70 bg-background/80"
		>
			{phase === "confirm" && recognition ? (
				// ── THE CONFIRM CARD: the reading, rendered + editable ──
				<div className="flex flex-col gap-2 p-2" data-testid="math-pad-confirm">
					<div className="flex items-center justify-between text-xs text-muted-foreground">
						<span>This is what I read — confirm or fix it:</span>
						{recognition.confidence !== undefined && (
							<span
								data-testid="math-pad-confidence"
								className={cnConfidence(recognition.confidence)}
								title={`Mathpix confidence: ${Math.round(recognition.confidence * 100)}%`}
							>
								{Math.round(recognition.confidence * 100)}% {recognition.confidence < 0.6 && "· please check"}
							</span>
						)}
					</div>
					{/* KaTeX preview (the latex-glyph seam — the app's own math
					    engine, katex's trusted renderToString output). */}
					<div
						data-testid="math-pad-preview"
						aria-hidden="true"
						className="min-h-12 overflow-x-auto rounded-md bg-foreground/[0.03] px-3 py-2 text-lg"
						dangerouslySetInnerHTML={{ __html: latexGlyphHtml(latexDraft || "\\;") }}
					/>
					<input
						data-testid="math-pad-input"
						value={latexDraft}
						onChange={(e) => {
							setLatexDraft(e.target.value);
							setCorrected(true);
						}}
						aria-label="The recognized LaTeX expression — edit if the reading is wrong"
						className="lh-input w-full rounded-md border border-border/70 bg-transparent px-2.5 py-1.5 font-mono text-sm outline-none focus:border-primary/50"
					/>
					<div className="flex items-center justify-end gap-2">
						<Button
							type="button"
							variant="ghost"
							className="h-8 px-2.5 text-xs"
							onClick={() => {
								setPhase("draw");
								setRecognition(null);
							}}
						>
							Write again
						</Button>
						<Button
							type="button"
							variant="ghost"
							className="h-8 px-2.5 text-xs"
							onClick={onClose}
						>
							Cancel
						</Button>
						<Button type="button" data-testid="math-pad-use" className="h-8 rounded-[6px] px-3 text-xs" onClick={useIt}>
							Use it
						</Button>
					</div>
				</div>
			) : (
				// ── THE CANVAS ──
				<div className="flex flex-col gap-1.5 p-2">
					<canvas
						ref={canvasRef}
						data-testid="math-pad-canvas"
						onPointerDown={onPointerDown}
						onPointerMove={onPointerMove}
						onPointerUp={endStroke}
						onPointerLeave={endStroke}
						onPointerCancel={endStroke}
						className="h-56 w-full cursor-crosshair touch-none rounded-md bg-foreground/[0.02]"
						aria-label="Write one expression with your finger, pen, or mouse"
					/>
					<div className="flex items-center justify-between gap-2">
						<span aria-hidden className="pl-1 text-xs text-muted-foreground">
							{error ? (
								<span data-testid="math-pad-error" className="text-destructive">
									{error}
								</span>
							) : (
								"one expression · write plainly"
							)}
						</span>
						<div className="flex items-center gap-1.5">
							<Button type="button" variant="ghost" className="h-8 gap-1 px-2.5 text-xs" onClick={undo} disabled={strokeCount === 0}>
								<Undo2Icon className="size-3.5" />
								Undo
							</Button>
							<Button type="button" variant="ghost" className="h-8 gap-1 px-2.5 text-xs" onClick={clear} disabled={strokeCount === 0}>
								<EraserIcon className="size-3.5" />
								Clear
							</Button>
							<Button
								type="button"
								data-testid="math-pad-recognize"
								className="h-8 gap-1.5 rounded-[6px] px-3 text-xs"
								disabled={strokeCount === 0 || phase === "recognizing"}
								onClick={() => void recognize()}
							>
								{phase === "recognizing" ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
								{phase === "recognizing" ? "Reading…" : "Recognize"}
							</Button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

/** The confidence badge's honest coloring: quiet when confident, amber
 *  when the reading deserves a second look. */
function cnConfidence(confidence: number): string {
	return confidence < 0.6
		? "rounded-full bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-600 dark:text-amber-400"
		: "text-muted-foreground/70";
}

/** The dock-side apply (exported for reuse): join the confirmed
 *  expression onto the field's current text — the dictation-final
 *  discipline, never clobbering what the learner already wrote. */
export function applyHandwritingToField(
	currentText: string,
	latex: string,
): string {
	return joinHandwriting(currentText, latex);
}
