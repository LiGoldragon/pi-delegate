/**
 * Session viewer overlay — streams a selected agent's output in real-time
 *
 * Key bindings:
 *   Ctrl+K     — kill the agent
 *   Ctrl+G     — guide (kill + input correction + resume)
 *   Ctrl+B     — background (close overlay, agent continues)
 *   Shift+Up   — scroll up
 *   Shift+Down — scroll down
 *   Escape     — back to session list
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { matchesKey, Key } from "@mariozechner/pi-tui";
import type { SessionManager } from "../session-manager.js";
import type { NormalizedEvent } from "../types.js";
import { statusIcon, formatTokens, formatUsage, toolCallSummary } from "../shared.js";

function eventToLine(ev: NormalizedEvent, themeFg: (c: string, t: string) => string): string | null {
	switch (ev.type) {
		case "text_delta":
			return ev.text || null;
		case "tool_call":
			return themeFg("muted", "\u2192 ") + themeFg("toolOutput", toolCallSummary(ev));
		case "tool_result":
			return ev.toolOutput ? themeFg("dim", ev.toolOutput.slice(0, 100)) : null;
		case "error":
			return themeFg("error", `Error: ${ev.error}`);
		case "usage":
			return ev.usage ? themeFg("dim", formatUsage({ usage: ev.usage } as any)) : null;
		case "done":
			return themeFg("success", "\u2500 done \u2500");
		default:
			return null;
	}
}

export interface ViewerResult {
	action: "back" | "background" | "kill" | "guide";
}

export async function showSessionViewer(
	pi: ExtensionAPI,
	manager: SessionManager,
	sessionId: string,
): Promise<ViewerResult> {
	const session = manager.getSession(sessionId);
	if (!session) return { action: "back" };

	return pi.ui.custom<ViewerResult>((tui, theme, _keybindings, done) => {
		let scrollOffset = 0;
		let lastEventCount = session.events.length;
		let cachedLines: string[] | null = null;

		const pollInterval = setInterval(() => {
			const current = manager.getSession(sessionId);
			if (!current) {
				cleanup();
				done({ action: "back" });
				return;
			}
			if (current.events.length !== lastEventCount || current.status !== "running") {
				lastEventCount = current.events.length;
				cachedLines = null;
				scheduleRender();
			}
		}, 100);

		function cleanup() {
			clearInterval(pollInterval);
		}

		let renderTimeout: ReturnType<typeof setTimeout> | undefined;
		function scheduleRender() {
			if (renderTimeout) clearTimeout(renderTimeout);
			renderTimeout = setTimeout(() => {
				tui.requestRender();
			}, 16);
		}

		function buildLines(width: number): string[] {
			if (cachedLines) return cachedLines;

			const current = manager.getSession(sessionId);
			if (!current) return [theme.fg("error", "Session not found")];

			const lines: string[] = [];

			const statusColor = current.status === "done" ? "success" : current.status === "running" ? "warning" : "error";
			lines.push(
				theme.fg(statusColor, statusIcon(current.status)) +
				" " +
				theme.fg("toolTitle", theme.bold(current.agent)) +
				theme.fg("dim", ` [${current.status}]`) +
				(current.model ? theme.fg("muted", ` ${current.model}`) : ""),
			);
			lines.push(theme.fg("dim", current.task.length > width - 4 ? current.task.slice(0, width - 4) + "..." : current.task));
			lines.push(theme.fg("muted", "\u2500".repeat(Math.min(width - 4, 60))));

			for (const ev of current.events) {
				const line = eventToLine(ev, theme.fg.bind(theme));
				if (line !== null) {
					for (const l of line.split("\n")) {
						lines.push(truncateToWidth(l, width - 4));
					}
				}
			}

			lines.push("");
			const hints: string[] = [];
			if (current.status === "running") {
				hints.push("Ctrl+K:kill", "Ctrl+G:guide", "Ctrl+B:background");
			} else {
				hints.push("Ctrl+G:guide (resume)");
			}
			hints.push("Esc:back");
			lines.push(theme.fg("dim", hints.join("  ")));

			cachedLines = lines;
			return lines;
		}

		return {
			render(width: number): string[] {
				const allLines = buildLines(width);
				const viewportHeight = Math.max(5, tui.terminal.rows - 6);

				const maxScroll = Math.max(0, allLines.length - viewportHeight);
				if (scrollOffset >= maxScroll - 1) scrollOffset = maxScroll;

				const visible = allLines.slice(scrollOffset, scrollOffset + viewportHeight);

				if (scrollOffset > 0) {
					visible[0] = theme.fg("dim", `\u2191 ${scrollOffset} more`) + "  " + (visible[0] || "");
				}
				if (scrollOffset + viewportHeight < allLines.length) {
					const remaining = allLines.length - scrollOffset - viewportHeight;
					visible.push(theme.fg("dim", `\u2193 ${remaining} more`));
				}

				return visible;
			},

			handleInput(data: string): void {
				if (matchesKey(data, Key.escape)) {
					cleanup();
					done({ action: "back" });
				} else if (matchesKey(data, Key.ctrl("b"))) {
					cleanup();
					done({ action: "background" });
				} else if (matchesKey(data, Key.ctrl("k"))) {
					manager.kill(sessionId);
					cachedLines = null;
					scheduleRender();
				} else if (matchesKey(data, Key.ctrl("g"))) {
					cleanup();
					done({ action: "guide" });
				} else if (matchesKey(data, Key.shift("up"))) {
					scrollOffset = Math.max(0, scrollOffset - 3);
					scheduleRender();
				} else if (matchesKey(data, Key.shift("down"))) {
					scrollOffset += 3;
					scheduleRender();
				}
			},

			invalidate(): void {
				cachedLines = null;
			},
		};
	}, {
		overlay: true,
		overlayOptions: {
			width: "80%",
			maxHeight: "80%",
			anchor: "center",
		},
	});
}
