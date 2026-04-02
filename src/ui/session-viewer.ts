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
import { Container, Text } from "@mariozechner/pi-tui";
import { matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";
import type { SessionManager } from "../session-manager.js";
import type { NormalizedEvent, Session } from "../types.js";

function icon(status: Session["status"]): string {
	switch (status) {
		case "running": return "\u23f3";
		case "done": return "\u2713";
		case "error": return "\u2717";
		case "killed": return "\u25a0";
	}
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

function eventToLine(ev: NormalizedEvent, themeFg: (c: string, t: string) => string): string | null {
	switch (ev.type) {
		case "text_delta":
			return ev.text || null;
		case "tool_call": {
			const name = ev.toolName || "?";
			if (name === "bash" && ev.toolArgs?.command) {
				const cmd = String(ev.toolArgs.command);
				return themeFg("muted", "\u2192 $ ") + themeFg("toolOutput", cmd.length > 70 ? cmd.slice(0, 70) + "..." : cmd);
			}
			const argsPreview = JSON.stringify(ev.toolArgs || {});
			return themeFg("muted", "\u2192 ") + themeFg("accent", name) + themeFg("dim", ` ${argsPreview.slice(0, 50)}`);
		}
		case "tool_result":
			return ev.toolOutput ? themeFg("dim", ev.toolOutput.slice(0, 100)) : null;
		case "error":
			return themeFg("error", `Error: ${ev.error}`);
		case "usage": {
			const u = ev.usage;
			if (!u) return null;
			return themeFg("dim", `\u2191${formatTokens(u.input)} \u2193${formatTokens(u.output)}`);
		}
		case "done":
			return themeFg("success", "\u2500 done \u2500");
		default:
			return null;
	}
}

export interface ViewerResult {
	action: "back" | "background" | "kill" | "guide";
	correction?: string;
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
		let renderedLines: string[] = [];
		let renderTimeout: ReturnType<typeof setTimeout> | undefined;

		// Subscribe to session updates via polling (simple approach)
		let lastEventCount = session.events.length;
		const pollInterval = setInterval(() => {
			const current = manager.getSession(sessionId);
			if (!current) {
				clearInterval(pollInterval);
				return;
			}
			if (current.events.length !== lastEventCount || current.status !== "running") {
				lastEventCount = current.events.length;
				scheduleRender();
			}
		}, 100);

		function scheduleRender() {
			if (renderTimeout) clearTimeout(renderTimeout);
			renderTimeout = setTimeout(() => {
				tui.requestRender();
			}, 16);
		}

		function buildLines(width: number): string[] {
			const current = manager.getSession(sessionId);
			if (!current) return [theme.fg("error", "Session not found")];

			const lines: string[] = [];

			// Header
			const statusColor = current.status === "done" ? "success" : current.status === "running" ? "warning" : "error";
			lines.push(
				theme.fg(statusColor, icon(current.status)) +
				" " +
				theme.fg("toolTitle", theme.bold(current.agent)) +
				theme.fg("dim", ` [${current.status}]`) +
				(current.model ? theme.fg("muted", ` ${current.model}`) : ""),
			);
			lines.push(theme.fg("dim", current.task.length > width - 4 ? current.task.slice(0, width - 4) + "..." : current.task));
			lines.push(theme.fg("muted", "\u2500".repeat(Math.min(width - 4, 60))));

			// Events
			for (const ev of current.events) {
				const line = eventToLine(ev, theme.fg.bind(theme));
				if (line !== null) {
					// Split multi-line text
					for (const l of line.split("\n")) {
						lines.push(truncateToWidth(l, width - 4));
					}
				}
			}

			// Footer hints
			lines.push("");
			const hints: string[] = [];
			if (current.status === "running") {
				hints.push("Ctrl+K:kill", "Ctrl+G:guide", "Ctrl+B:background");
			} else {
				hints.push("Ctrl+G:guide (resume)");
			}
			hints.push("Esc:back");
			lines.push(theme.fg("dim", hints.join("  ")));

			return lines;
		}

		return {
			render(width: number): string[] {
				renderedLines = buildLines(width);
				const viewportHeight = Math.max(5, tui.terminal.rows - 6);

				// Auto-scroll to bottom when at end
				const maxScroll = Math.max(0, renderedLines.length - viewportHeight);
				if (scrollOffset >= maxScroll - 1) scrollOffset = maxScroll;

				const visible = renderedLines.slice(scrollOffset, scrollOffset + viewportHeight);

				// Scroll indicator
				if (scrollOffset > 0) {
					visible[0] = theme.fg("dim", `\u2191 ${scrollOffset} more`) + "  " + (visible[0] || "");
				}
				if (scrollOffset + viewportHeight < renderedLines.length) {
					const remaining = renderedLines.length - scrollOffset - viewportHeight;
					visible.push(theme.fg("dim", `\u2193 ${remaining} more`));
				}

				return visible;
			},

			handleInput(data: string): void {
				if (matchesKey(data, Key.escape)) {
					clearInterval(pollInterval);
					done({ action: "back" });
				} else if (matchesKey(data, Key.ctrl("b"))) {
					clearInterval(pollInterval);
					done({ action: "background" });
				} else if (matchesKey(data, Key.ctrl("k"))) {
					manager.kill(sessionId);
					scheduleRender();
				} else if (matchesKey(data, Key.ctrl("g"))) {
					clearInterval(pollInterval);
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
				// Will be rebuilt on next render
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
