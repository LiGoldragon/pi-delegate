/**
 * Pi CLI adapter
 *
 * Spawns: pi --mode json -p --no-session $task
 * Resume: not supported (new session)
 *
 * Reuses the same JSON event format as the subagent example.
 */

import type { AgentAdapter, NormalizedEvent, SpawnOpts } from "../types.js";
import { safeParseLine } from "../shared.js";

export const pi: AgentAdapter = {
	bin: "pi",

	spawnArgs(opts: SpawnOpts): string[] {
		const args = ["--mode", "json", "-p", "--no-session"];
		if (opts.model) args.push("--model", opts.model);
		args.push(`Task: ${opts.task}`);
		return args;
	},

	parseLine(line: string): NormalizedEvent[] {
		const event = safeParseLine(line);
		if (!event) return [];

		const events: NormalizedEvent[] = [];

		if (event.type === "message_end" && event.message) {
			const msg = event.message;
			if (msg.role === "assistant") {
				for (const part of msg.content || []) {
					if (part.type === "text") {
						events.push({ type: "text_delta", text: part.text });
					} else if (part.type === "toolCall") {
						events.push({
							type: "tool_call",
							toolName: part.name,
							toolArgs: part.arguments,
						});
					}
				}
				const usage = msg.usage;
				if (usage) {
					events.push({
						type: "usage",
						usage: {
							input: usage.input || 0,
							output: usage.output || 0,
							cacheRead: usage.cacheRead || 0,
							cacheWrite: usage.cacheWrite || 0,
							cost: usage.cost?.total || 0,
							turns: 1,
						},
					});
				}
				if (msg.stopReason === "error" && msg.errorMessage) {
					events.push({ type: "error", error: msg.errorMessage });
				}
			}
		}

		if (event.type === "tool_result_end" && event.message) {
			for (const part of event.message.content || []) {
				if (part.type === "text") {
					events.push({ type: "tool_result", toolOutput: part.text });
				}
			}
		}

		return events;
	},

	resumeArgs(_sessionId: string, correction: string, opts: SpawnOpts): string[] | null {
		const args = ["--mode", "json", "-p", "--no-session"];
		if (opts.model) args.push("--model", opts.model);
		args.push(`Task: ${correction}`);
		return args;
	},
};
