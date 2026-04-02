/**
 * Codex CLI adapter
 *
 * Spawns: codex exec $task --json
 * Resume: not supported (new session)
 */

import type { AgentAdapter, NormalizedEvent, SpawnOpts } from "../types.js";
import { safeParseLine } from "../shared.js";

export const codex: AgentAdapter = {
	bin: "codex",

	spawnArgs(opts: SpawnOpts): string[] {
		const args = ["exec", opts.task, "--json", "--full-auto"];
		if (opts.model) args.push("--model", opts.model);
		return args;
	},

	parseLine(line: string): NormalizedEvent[] {
		const event = safeParseLine(line);
		if (!event) return [];

		const events: NormalizedEvent[] = [];

		if (event.type === "item.completed" && event.item) {
			const item = event.item;
			if (item.type === "agent_message" && item.content) {
				events.push({ type: "text_delta", text: item.content });
			}
			if (item.type === "command_execution") {
				events.push({
					type: "tool_call",
					toolName: "bash",
					toolArgs: { command: item.command },
				});
				if (item.output) {
					events.push({ type: "tool_result", toolName: "bash", toolOutput: item.output });
				}
			}
			if (item.type === "file_change") {
				events.push({
					type: "tool_call",
					toolName: "edit",
					toolArgs: { file: item.file, action: item.action },
				});
			}
			if (item.type === "mcp_tool_call") {
				events.push({
					type: "tool_call",
					toolName: item.tool_name || "mcp",
					toolArgs: item.arguments,
				});
				if (item.result) {
					events.push({ type: "tool_result", toolName: item.tool_name, toolOutput: item.result });
				}
			}
		}

		if (event.type === "item.updated" && event.item?.type === "agent_message" && event.item?.content) {
			events.push({ type: "text_delta", text: event.item.content });
		}

		if (event.type === "turn.completed") {
			const usage = event.usage;
			if (usage) {
				events.push({
					type: "usage",
					usage: {
						input: usage.input_tokens || 0,
						output: usage.output_tokens || 0,
						cacheRead: usage.cached_tokens || 0,
						cacheWrite: 0,
						cost: 0,
						turns: 1,
					},
				});
			}
			events.push({ type: "done", sessionId: event.thread_id });
		}

		if (event.type === "turn.failed" || event.type === "error") {
			events.push({ type: "error", error: event.message || JSON.stringify(event) });
		}

		return events;
	},

	resumeArgs(_sessionId: string, correction: string, opts: SpawnOpts): string[] | null {
		const args = ["exec", correction, "--json", "--full-auto"];
		if (opts.model) args.push("--model", opts.model);
		return args;
	},
};
