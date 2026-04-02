/**
 * Shared utilities used across index.ts and UI components
 */

import type { NormalizedEvent, Session } from "./types.js";

export function statusIcon(status: Session["status"]): string {
	switch (status) {
		case "running": return "\u23f3";
		case "done": return "\u2713";
		case "error": return "\u2717";
		case "killed": return "\u25a0";
	}
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsage(session: Session): string {
	const u = session.usage;
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`\u2191${formatTokens(u.input)}`);
	if (u.output) parts.push(`\u2193${formatTokens(u.output)}`);
	if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (session.model) parts.push(session.model);
	return parts.join(" ");
}

export function toolCallSummary(ev: NormalizedEvent): string {
	if (ev.type !== "tool_call") return "";
	const name = ev.toolName || "?";
	if (name === "bash" && ev.toolArgs?.command) {
		const cmd = String(ev.toolArgs.command);
		return `$ ${cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd}`;
	}
	if ((name === "read" || name === "edit" || name === "write") && (ev.toolArgs?.file_path || ev.toolArgs?.path)) {
		return `${name} ${ev.toolArgs.file_path || ev.toolArgs.path}`;
	}
	const argsStr = JSON.stringify(ev.toolArgs || {});
	return `${name} ${argsStr.length > 50 ? argsStr.slice(0, 50) + "..." : argsStr}`;
}

export function safeParseLine(line: string): any | null {
	if (!line.trim()) return null;
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}
