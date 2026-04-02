/**
 * Session list overlay — pick a delegate session to view, kill, or guide
 *
 * Key bindings:
 *   Enter  — view session output
 *   Ctrl+K — kill selected session
 *   Ctrl+G — guide (kill + resume with correction)
 *   Escape — close
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { matchesKey, Key } from "@mariozechner/pi-tui";
import type { SessionManager } from "../session-manager.js";
import { statusIcon } from "../shared.js";

interface SessionListAction {
	type: "view" | "kill" | "guide";
	sessionId: string;
}

export async function showSessionList(
	pi: ExtensionAPI,
	manager: SessionManager,
): Promise<SessionListAction | null> {
	const sessions = manager.listSessions();
	if (sessions.length === 0) {
		pi.ui.notify("No delegate sessions", "info");
		return null;
	}

	return pi.ui.custom<SessionListAction | null>((tui, theme, _keybindings, done) => {
		let selectedIndex = 0;
		const container = new Container();

		function rebuild() {
			container.clearChildren();

			const currentSessions = manager.listSessions();
			if (currentSessions.length === 0) {
				container.addChild(new Text(theme.fg("muted", "No sessions"), 1, 1));
				return;
			}

			container.addChild(new Text(
				theme.fg("toolTitle", theme.bold(" Delegate Sessions ")),
				1, 0,
			));
			container.addChild(new Text(
				theme.fg("dim", " Enter:view  Ctrl+K:kill  Ctrl+G:guide  Esc:close"),
				1, 0,
			));
			container.addChild(new Text("", 0, 0));

			for (let i = 0; i < currentSessions.length; i++) {
				const s = currentSessions[i];
				const selected = i === selectedIndex;
				const prefix = selected ? theme.fg("accent", "\u25b6 ") : "  ";
				const statusColor = s.status === "done" ? "success" : s.status === "running" ? "warning" : "error";
				const statusText = theme.fg(statusColor, statusIcon(s.status));

				const taskPreview = s.task.length > 50 ? s.task.slice(0, 50) + "..." : s.task;
				const line = `${prefix}${statusText} ${theme.fg("accent", s.agent)} ${theme.fg("dim", taskPreview)}`;

				container.addChild(new Text(
					selected ? theme.fg("accent", line) : line,
					1, 0,
				));
			}
		}

		rebuild();

		return {
			render(width: number): string[] {
				return container.render(width);
			},

			handleInput(data: string): void {
				const currentSessions = manager.listSessions();
				if (currentSessions.length === 0) {
					done(null);
					return;
				}

				if (matchesKey(data, Key.up)) {
					selectedIndex = Math.max(0, selectedIndex - 1);
					rebuild();
					container.invalidate();
				} else if (matchesKey(data, Key.down)) {
					selectedIndex = Math.min(currentSessions.length - 1, selectedIndex + 1);
					rebuild();
					container.invalidate();
				} else if (matchesKey(data, Key.enter)) {
					const session = currentSessions[selectedIndex];
					if (session) done({ type: "view", sessionId: session.id });
				} else if (matchesKey(data, Key.ctrl("k"))) {
					const session = currentSessions[selectedIndex];
					if (session && session.status === "running") {
						done({ type: "kill", sessionId: session.id });
					}
				} else if (matchesKey(data, Key.ctrl("g"))) {
					const session = currentSessions[selectedIndex];
					if (session) {
						done({ type: "guide", sessionId: session.id });
					}
				} else if (matchesKey(data, Key.escape)) {
					done(null);
				}
			},

			invalidate(): void {
				container.invalidate();
			},
		};
	}, {
		overlay: true,
		overlayOptions: {
			width: "70%",
			maxHeight: "60%",
			anchor: "center",
		},
	});
}
