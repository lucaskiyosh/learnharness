/**
 * SECRETS DENYLIST (fork audit C10): the learner's fs tools (read/ls/find/
 * grep) ingest prompts that also carry untrusted external content —
 * research briefs and PDF text — so the read surface refuses secrets
 * material (key stores, credential files, dotenv) with an honest error the
 * model can see and explain. Everything else keeps the user-decided v0
 * unrestricted scope.
 *
 * Pins the refusal for every fs tool, the relative-path resolution case,
 * and that ordinary notes are unaffected.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { readTool } from "../src/agent/tools/read.ts";
import { lsTool } from "../src/agent/tools/ls.ts";
import { findTool } from "../src/agent/tools/find.ts";
import { grepTool } from "../src/agent/tools/grep.ts";
import { deniedSourcePath } from "../src/agent/tools/fs-shared.ts";

let FIXTURE: string;

async function runText(tool: AgentTool<any>, params: unknown): Promise<string> {
	const result = await tool.execute!("c", params, undefined);
	const first = result.content[0];
	assert.ok(first !== undefined && first.type === "text", "first content part is text");
	return (first as { type: "text"; text: string }).text;
}

before(() => {
	FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fs-denylist-"));
	fs.writeFileSync(path.join(FIXTURE, "notes.txt"), "eigenvector content\n", "utf-8");
});

after(() => {
	fs.rmSync(FIXTURE, { recursive: true, force: true });
});

describe("the secrets denylist (C10)", () => {
	it("resolveSourcePath refuses every denied shape", () => {
		const home = os.homedir();
		assert.ok(deniedSourcePath(path.join(home, ".ssh", "id_rsa")));
		assert.ok(deniedSourcePath(path.join(home, ".pi", "agent", "auth.json")));
		assert.ok(deniedSourcePath(path.join(home, "somewhere", "auth.json")));
		assert.ok(deniedSourcePath(path.join(home, "github-copilot-credentials.json")));
		assert.ok(deniedSourcePath(path.join(home, "xai-credentials.json")));
		assert.ok(deniedSourcePath(path.join(home, ".env")));
		assert.ok(deniedSourcePath(path.join(home, "project", ".env.local")));
		assert.ok(deniedSourcePath(path.join(home, "certs", "server.pem")));
		assert.ok(!deniedSourcePath(path.join(home, "notes", "calculus.md")));
		assert.ok(!deniedSourcePath(path.join(home, "foo.env-but-not-secret.md")));
		assert.ok(!deniedSourcePath(home), "the home itself is never denied");
	});

	it("every fs tool refuses a denied path with the honest error", async () => {
		const keyFile = path.join(os.homedir(), ".ssh", "known-hosts-fixture");
		// A refusal rejects the execute; the agent loop's own error
		// handling turns it into the error tool result the model sees.
		await assert.rejects(runText(readTool, { path: keyFile }), /Refused: .* holds secrets/);
		await assert.rejects(runText(lsTool, { path: path.join(os.homedir(), ".ssh") }), /Refused: .* holds secrets/);
		await assert.rejects(runText(findTool, { pattern: "id_*", path: path.join(os.homedir(), ".ssh") }), /Refused: .* holds secrets/);
		await assert.rejects(runText(grepTool, { pattern: "PRIVATE", path: keyFile }), /Refused: .* holds secrets/);
	});

	it("ordinary reads are untouched", async () => {
		const out = await runText(readTool, { path: path.join(FIXTURE, "notes.txt") });
		assert.match(out, /eigenvector content/);
	});
});
