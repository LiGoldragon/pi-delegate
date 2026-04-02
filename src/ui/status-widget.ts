/**
 * Footer status widget — persistent bar showing running/completed delegates
 */

import type { Session } from "../types.js";
import { statusIcon } from "../shared.js";

export function formatStatusLine(
	sessions: Session[],
	themeFg: (color: string, text: string) => string,
): string {
	if (sessions.length === 0) return "";

	const running = sessions.filter((s) => s.status === "running");
	const done = sessions.filter((s) => s.status !== "running");

	const parts: string[] = [];

	for (const s of running) {
		parts.push(themeFg("warning", `${statusIcon(s.status)} ${s.agent}`));
	}
	for (const s of done) {
		const color = s.status === "done" ? "success" : "error";
		parts.push(themeFg(color, `${statusIcon(s.status)} ${s.agent}`));
	}

	const summary = parts.join("  ");
	const hint = running.length > 0 ? themeFg("dim", "  Ctrl+D: sessions") : "";
	return summary + hint;
}
