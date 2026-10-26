/**
 * Crash-atomic whole-file replace (fork audit C3, 2026-10-26): a torn
 * write — process kill or power loss mid-writeFileSync — must never
 * leave a truncated JSON record in place of the original, because every
 * reader treats a corrupt file as absent and the session/job/settings
 * record becomes unrecoverable through the app.
 *
 * The idiom mirrors the repo's own crash-safe writers (auth.ts's
 * tmp-in-same-dir + chmod + rename; subscription-store.cjs's fsync) and
 * POSIX rename atomicity: the tmp file is written + fsynced, then renamed
 * over the target — the target is either the complete old content or the
 * complete new content, never a mix. The worst crash leaves a leftover
 * .tmp file, never a corrupted record. Node's rename replaces an existing
 * file on Windows too (MoveFileEx REPLACE_EXISTING).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

/** Write `text` to `target` atomically (same directory, tmp + fsync +
 *  rename). Creates parent directories. `mode` seeds the tmp file's
 *  permissions (the rename carries them to the final path). Throws after
 *  removing the tmp file on failure — the original is untouched. */
export function atomicWriteText(target: string, text: string, mode?: number): void {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`);
	try {
		const handle = fs.openSync(tmp, "w", mode);
		try {
			fs.writeFileSync(handle, text, "utf-8");
			fs.fsyncSync(handle);
		} finally {
			fs.closeSync(handle);
		}
		fs.renameSync(tmp, target);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* best-effort cleanup — the original record is intact */
		}
		throw err;
	}
}
