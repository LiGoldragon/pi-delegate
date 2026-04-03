/**
 * pi-delegate — delegate tasks to Claude, Gemini, Codex, and Pi via official CLIs
 *
 * Registers a `delegate` tool that spawns agent subprocesses in headless mode,
 * streams their JSON output, and returns structured results to the parent agent.
 *
 * UI layer:
 *   - Status widget below editor showing active/completed delegates
 *   - delegate_sessions tool opens session list overlay (view, kill, guide)
 *   - Session viewer overlay streams agent output in real-time
 *   - Ctrl+G guide flow: kill agent, input correction, resume
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { SessionManager } from "./session-manager.js";
import { statusIcon, formatUsage, toolCallSummary } from "./shared.js";
import type { AgentId, DelegateDetails, Session } from "./types.js";
import { formatStatusLine } from "./ui/status-widget.js";
import { showSessionList } from "./ui/session-list.js";
import { showSessionViewer } from "./ui/session-viewer.js";

const MAX_PARALLEL = 4;
const COLLAPSED_LINES = 8;
const WIDGET_ID = "pi-delegate";

function truncateOutput(text: string, maxLines: number): { text: string; truncated: boolean } {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return { text, truncated: false };
	return { text: lines.slice(-maxLines).join("\n"), truncated: true };
}

const AgentIdSchema = StringEnum(["claude", "gemini", "codex", "pi"] as const, {
	description: "Which agent CLI to delegate to",
});

const TaskItem = Type.Object({
	agent: AgentIdSchema,
	task: Type.String({ description: "Task to delegate" }),
	model: Type.Optional(Type.String({ description: "Model override" })),
	cwd: Type.Optional(Type.String({ description: "Working directory" })),
});

const DelegateParams = Type.Object({
	agent: Type.Optional(AgentIdSchema),
	task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
	model: Type.Optional(Type.String({ description: "Model override (single mode)" })),
	cwd: Type.Optional(Type.String({ description: "Working directory (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, {
		description: "Array of tasks for parallel delegation (max 4)",
	})),
});

export default function (pi: ExtensionAPI) {
	const manager = new SessionManager();
	let lastWidgetLine = "";

	// --- UI: Status widget updates (with change detection) ---

	function updateStatusWidget() {
		if (!pi.ui?.theme) return; // No TUI in headless mode
		const sessions = manager.listSessions();
		if (sessions.length === 0) {
			if (lastWidgetLine !== "") {
				lastWidgetLine = "";
				pi.ui.setWidget(WIDGET_ID, undefined);
			}
			return;
		}
		const line = formatStatusLine(sessions, pi.ui.theme.fg.bind(pi.ui.theme));
		if (line !== lastWidgetLine) {
			lastWidgetLine = line;
			pi.ui.setWidget(WIDGET_ID, [line], { placement: "belowEditor" });
		}
	}

	// --- UI: Session list + viewer loop ---

	async function openSessionUI() {
		let keepGoing = true;
		while (keepGoing) {
			const action = await showSessionList(pi, manager);
			if (!action) {
				keepGoing = false;
				break;
			}

			if (action.type === "kill") {
				manager.kill(action.sessionId);
				updateStatusWidget();
				continue;
			}

			if (action.type === "guide") {
				await handleGuide(action.sessionId);
				continue;
			}

			if (action.type === "view") {
				const viewResult = await showSessionViewer(pi, manager, action.sessionId);

				if (viewResult.action === "back") continue;
				if (viewResult.action === "background") { keepGoing = false; break; }
				if (viewResult.action === "kill") {
					manager.kill(action.sessionId);
					updateStatusWidget();
					continue;
				}
				if (viewResult.action === "guide") {
					await handleGuide(action.sessionId);
					continue;
				}
			}
		}
	}

	async function handleGuide(sessionId: string) {
		const session = manager.getSession(sessionId);
		if (!session) return;

		if (session.status === "running") {
			manager.kill(sessionId);
		}

		const correction = await pi.ui.input(
			`Guide ${session.agent} (${sessionId}):`,
			"Enter correction or new direction...",
		);

		if (!correction || correction.trim() === "") return;

		const resumed = await manager.resume(sessionId, correction.trim(), () => {
			updateStatusWidget();
		});

		if (!resumed) {
			pi.ui.notify(`Could not resume ${session.agent} session`, "error");
			return;
		}

		updateStatusWidget();
		pi.ui.notify(`Resumed as ${resumed.id}`, "info");
	}

	// --- Tool: delegate_sessions (manual UI trigger) ---

	pi.registerTool({
		name: "delegate_sessions",
		label: "Delegate Sessions",
		description: "Open the delegate session manager UI. View, kill, or guide running delegate agents.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			await openSessionUI();
			const sessions = manager.listSessions();
			const summary = sessions.map((s) =>
				`${statusIcon(s.status)} ${s.agent}: ${s.task.slice(0, 60)}`
			).join("\n");
			return {
				content: [{ type: "text", text: summary || "No sessions" }],
				details: { mode: "single", sessions } as DelegateDetails,
			};
		},
	});

	// --- Tool: delegate ---

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: [
			"Delegate tasks to external agent CLIs (Claude, Gemini, Codex, Pi).",
			"Uses official CLI tools in headless mode with structured JSON output.",
			"Single mode: { agent, task }. Parallel mode: { tasks: [{ agent, task }, ...] }.",
			"Each agent runs as an isolated subprocess. Results include full output and usage stats.",
			"User can invoke delegate_sessions to view/kill/guide running agents.",
		].join(" "),
		parameters: DelegateParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const hasSingle = Boolean(params.agent && params.task);
			const hasParallel = (params.tasks?.length ?? 0) > 0;

			if (hasSingle === hasParallel) {
				return {
					content: [{ type: "text", text: "Provide either (agent + task) for single mode, or tasks[] for parallel." }],
					details: { mode: "single", sessions: [] } as DelegateDetails,
				};
			}

			const makeResult = (sessions: Session[], mode: "single" | "parallel"): AgentToolResult<DelegateDetails> => {
				const output = sessions.map((s) => {
					const preview = s.output.length > 500 ? s.output.slice(0, 500) + "\n..." : s.output;
					return sessions.length > 1
						? `[${s.agent}] ${statusIcon(s.status)}\n${preview || "(no output)"}`
						: preview || "(no output)";
				}).join("\n\n");

				return {
					content: [{ type: "text", text: output }],
					details: { mode, sessions },
				};
			};

			const sessionUpdateHandler = (_session: Session) => {
				updateStatusWidget();
			};

			if (hasSingle) {
				const agent = params.agent as AgentId;
				const session = await manager.spawn(
					agent,
					{
						task: params.task!,
						model: params.model,
						cwd: params.cwd ?? ctx.cwd,
						signal,
					},
					onUpdate
						? (s) => { updateStatusWidget(); onUpdate(makeResult([s], "single")); }
						: sessionUpdateHandler,
				);

				const result = makeResult([session], "single");
				if (session.status === "error") result.isError = true;
				updateStatusWidget();
				return result;
			}

			// Parallel mode
			const tasks = params.tasks!;
			if (tasks.length > MAX_PARALLEL) {
				return {
					content: [{ type: "text", text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL}.` }],
					details: { mode: "parallel", sessions: [] } as DelegateDetails,
				};
			}

			const sessionsByIndex = new Map<number, Session>();
			const promises = tasks.map(async (t, idx) => {
				const session = await manager.spawn(
					t.agent as AgentId,
					{
						task: t.task,
						model: t.model,
						cwd: t.cwd ?? ctx.cwd,
						signal,
					},
					onUpdate
						? (s) => {
								sessionsByIndex.set(idx, s);
								updateStatusWidget();
								onUpdate(makeResult(Array.from(sessionsByIndex.values()), "parallel"));
							}
						: (s) => {
								sessionsByIndex.set(idx, s);
								updateStatusWidget();
							},
				);
				sessionsByIndex.set(idx, session);
				return session;
			});

			const sessions = await Promise.all(promises);
			const result = makeResult(sessions, "parallel");
			if (sessions.some((s) => s.status === "error")) result.isError = true;
			updateStatusWidget();
			return result;
		},

		renderCall(args, theme, _context) {
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("delegate ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)} ${theme.fg("dim", preview)}`;
				}
				if (args.tasks.length > 3) {
					text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				}
				return new Text(text, 0, 0);
			}

			const agent = args.agent || "...";
			const task = args.task || "...";
			const preview = task.length > 60 ? `${task.slice(0, 60)}...` : task;
			let text =
				theme.fg("toolTitle", theme.bold("delegate ")) +
				theme.fg("accent", agent);
			if (args.model) text += theme.fg("muted", ` (${args.model})`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as DelegateDetails | undefined;
			if (!details || details.sessions.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			if (details.sessions.length === 1) {
				const s = details.sessions[0];
				const iconStr = theme.fg(
					s.status === "done" ? "success" : s.status === "running" ? "warning" : "error",
					statusIcon(s.status),
				);

				if (expanded) {
					const container = new Container();
					container.addChild(new Text(
						`${iconStr} ${theme.fg("toolTitle", theme.bold(s.agent))} ${theme.fg("dim", formatUsage(s))}`,
						0, 0,
					));
					container.addChild(new Spacer(1));

					const toolCalls = s.events.filter((e) => e.type === "tool_call");
					if (toolCalls.length > 0) {
						container.addChild(new Text(theme.fg("muted", "\u2500\u2500\u2500 Tools \u2500\u2500\u2500"), 0, 0));
						for (const tc of toolCalls) {
							container.addChild(new Text(
								theme.fg("muted", "\u2192 ") + theme.fg("toolOutput", toolCallSummary(tc)),
								0, 0,
							));
						}
						container.addChild(new Spacer(1));
					}

					if (s.output.trim()) {
						container.addChild(new Text(theme.fg("muted", "\u2500\u2500\u2500 Output \u2500\u2500\u2500"), 0, 0));
						container.addChild(new Markdown(s.output.trim(), 0, 0, mdTheme));
					} else {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					}

					return container;
				}

				const { text: truncated, truncated: wasTruncated } = truncateOutput(s.output, COLLAPSED_LINES);
				let text = `${iconStr} ${theme.fg("toolTitle", theme.bold(s.agent))} ${theme.fg("dim", formatUsage(s))}`;
				if (truncated.trim()) {
					text += `\n${theme.fg("toolOutput", truncated)}`;
				} else {
					text += `\n${theme.fg("muted", s.status === "running" ? "(running...)" : "(no output)")}`;
				}
				if (wasTruncated) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			// Parallel view
			const running = details.sessions.filter((s) => s.status === "running").length;
			const done = details.sessions.filter((s) => s.status !== "running").length;
			const allDone = running === 0;
			const iconStr = allDone
				? theme.fg("success", "\u2713")
				: theme.fg("warning", "\u23f3");
			const status = allDone
				? `${done}/${details.sessions.length} done`
				: `${done}/${details.sessions.length} done, ${running} running`;

			if (expanded && allDone) {
				const container = new Container();
				container.addChild(new Text(
					`${iconStr} ${theme.fg("toolTitle", theme.bold("delegate "))}${theme.fg("accent", status)}`,
					0, 0,
				));

				for (const s of details.sessions) {
					const sIcon = theme.fg(
						s.status === "done" ? "success" : "error",
						statusIcon(s.status),
					);
					container.addChild(new Spacer(1));
					container.addChild(new Text(
						`${theme.fg("muted", "\u2500\u2500\u2500 ")}${theme.fg("accent", s.agent)} ${sIcon} ${theme.fg("dim", formatUsage(s))}`,
						0, 0,
					));
					if (s.output.trim()) {
						container.addChild(new Markdown(s.output.trim(), 0, 0, mdTheme));
					} else {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					}
				}
				return container;
			}

			let text = `${iconStr} ${theme.fg("toolTitle", theme.bold("delegate "))}${theme.fg("accent", status)}`;
			for (const s of details.sessions) {
				const sIcon = theme.fg(
					s.status === "done" ? "success" : s.status === "running" ? "warning" : "error",
					statusIcon(s.status),
				);
				const { text: truncated } = truncateOutput(s.output, 3);
				text += `\n\n${theme.fg("muted", "\u2500\u2500\u2500 ")}${theme.fg("accent", s.agent)} ${sIcon}`;
				if (truncated.trim()) {
					text += `\n${theme.fg("toolOutput", truncated)}`;
				} else {
					text += `\n${theme.fg("muted", s.status === "running" ? "(running...)" : "(no output)")}`;
				}
			}
			if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(text, 0, 0);
		},
	});
}
