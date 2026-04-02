/**
 * pi-delegate — delegate tasks to Claude, Gemini, Codex, and Pi via official CLIs
 *
 * Registers a `delegate` tool that spawns agent subprocesses in headless mode,
 * streams their JSON output, and returns structured results to the parent agent.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { SessionManager } from "./session-manager.js";
import type { AgentId, DelegateDetails, NormalizedEvent, Session } from "./types.js";

const MAX_PARALLEL = 4;
const COLLAPSED_LINES = 8;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(session: Session): string {
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

function statusIcon(status: Session["status"]): string {
	switch (status) {
		case "running": return "\u23f3";
		case "done": return "\u2713";
		case "error": return "\u2717";
		case "killed": return "\u25a0";
	}
}

function toolCallSummary(ev: NormalizedEvent): string {
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

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: [
			"Delegate tasks to external agent CLIs (Claude, Gemini, Codex, Pi).",
			"Uses official CLI tools in headless mode with structured JSON output.",
			"Single mode: { agent, task }. Parallel mode: { tasks: [{ agent, task }, ...] }.",
			"Each agent runs as an isolated subprocess. Results include full output and usage stats.",
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
						? (_session, all) => {
								onUpdate(makeResult([_session], "single"));
							}
						: undefined,
				);

				const result = makeResult([session], "single");
				if (session.status === "error") result.isError = true;
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

			const allSessions: Session[] = [];
			const promises = tasks.map(async (t) => {
				const session = await manager.spawn(
					t.agent as AgentId,
					{
						task: t.task,
						model: t.model,
						cwd: t.cwd ?? ctx.cwd,
						signal,
					},
					onUpdate
						? (s, _all) => {
								const idx = allSessions.indexOf(s);
								if (idx === -1) allSessions.push(s);
								onUpdate(makeResult(allSessions, "parallel"));
							}
						: undefined,
				);
				if (!allSessions.includes(session)) allSessions.push(session);
				return session;
			});

			const sessions = await Promise.all(promises);
			const result = makeResult(sessions, "parallel");
			if (sessions.some((s) => s.status === "error")) result.isError = true;
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
				const icon = theme.fg(
					s.status === "done" ? "success" : s.status === "running" ? "warning" : "error",
					statusIcon(s.status),
				);

				if (expanded) {
					const container = new Container();
					container.addChild(new Text(
						`${icon} ${theme.fg("toolTitle", theme.bold(s.agent))} ${theme.fg("dim", formatUsage(s))}`,
						0, 0,
					));
					container.addChild(new Spacer(1));

					// Tool calls
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

					// Output
					if (s.output.trim()) {
						container.addChild(new Text(theme.fg("muted", "\u2500\u2500\u2500 Output \u2500\u2500\u2500"), 0, 0));
						container.addChild(new Markdown(s.output.trim(), 0, 0, mdTheme));
					} else {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					}

					return container;
				}

				// Collapsed
				const { text: truncated, truncated: wasTruncated } = truncateOutput(s.output, COLLAPSED_LINES);
				let text = `${icon} ${theme.fg("toolTitle", theme.bold(s.agent))} ${theme.fg("dim", formatUsage(s))}`;
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
			const icon = allDone
				? theme.fg("success", "\u2713")
				: theme.fg("warning", "\u23f3");
			const status = allDone
				? `${done}/${details.sessions.length} done`
				: `${done}/${details.sessions.length} done, ${running} running`;

			if (expanded && allDone) {
				const container = new Container();
				container.addChild(new Text(
					`${icon} ${theme.fg("toolTitle", theme.bold("delegate "))}${theme.fg("accent", status)}`,
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

			// Collapsed parallel
			let text = `${icon} ${theme.fg("toolTitle", theme.bold("delegate "))}${theme.fg("accent", status)}`;
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
