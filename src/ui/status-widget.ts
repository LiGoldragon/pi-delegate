/**
 * Footer status widget — persistent bar showing running/completed delegates
 *
 * Rendered via ctx.ui.setWidget(), updates on every session state change.
 */

import type { Session } from "../types.js";

function icon(status: Session["status"]): string {
	switch (status) {
		case "running": return "\u23f3";
		case "done": return "\u2713";
		case "error": return "\u2717";
		case "killed": return "\u25a0";
	}
}

export function formatStatusLine(
	sessions: Session[],
	themeFg: (color: string, text: string) => string,
): string {
	if (sessions.length === 0) return "";

	const running = sessions.filter((s) => s.status === "running");
	const done = sessions.filter((s) => s.status !== "running");

	const parts: string[] = [];

	for (const s of running) {
		parts.push(themeFg("warning", `${icon(s.status)} ${s.agent}`));
	}
	for (const s of done) {
		const color = s.status === "done" ? "success" : "error";
		parts.push(themeFg(color, `${icon(s.status)} ${s.agent}`));
	}

	const summary = parts.join("  ");
	const hint = running.length > 0 ? themeFg("dim", "  Ctrl+D: sessions") : "";
	return summary + hint;
}
