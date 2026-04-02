/**
 * Claude Code CLI adapter
 *
 * Spawns: claude -p $task --output-format stream-json
 * Resume: claude -p $correction --resume $sessionId --output-format stream-json
 */

import type { AgentAdapter, NormalizedEvent, SpawnOpts } from "../types.js";

export const claude: AgentAdapter = {
	bin: "claude",

	spawnArgs(opts: SpawnOpts): string[] {
		const args = ["-p", opts.task, "--output-format", "stream-json"];
		if (opts.model) args.push("--model", opts.model);
		return args;
	},

	parseLine(line: string): NormalizedEvent[] {
		if (!line.trim()) return [];
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return [];
		}

		const events: NormalizedEvent[] = [];

		if (event.type === "assistant" && event.message) {
			const msg = event.message;
			if (msg.content) {
				for (const block of msg.content) {
					if (block.type === "text") {
						events.push({ type: "text_delta", text: block.text });
					} else if (block.type === "tool_use") {
						events.push({
							type: "tool_call",
							toolName: block.name,
							toolArgs: block.input,
						});
					}
				}
			}
			if (msg.usage) {
				events.push({
					type: "usage",
					usage: {
						input: msg.usage.input_tokens || 0,
						output: msg.usage.output_tokens || 0,
						cacheRead: msg.usage.cache_read_input_tokens || 0,
						cacheWrite: msg.usage.cache_creation_input_tokens || 0,
						cost: 0,
						turns: 1,
					},
				});
			}
		}

		if (event.type === "result") {
			events.push({
				type: "done",
				sessionId: event.session_id,
				text: event.result,
				usage: event.usage
					? {
							input: event.usage.input_tokens || 0,
							output: event.usage.output_tokens || 0,
							cacheRead: event.usage.cache_read_input_tokens || 0,
							cacheWrite: event.usage.cache_creation_input_tokens || 0,
							cost: event.cost_usd || 0,
							turns: event.num_turns || 1,
						}
					: undefined,
			});
		}

		if (event.type === "error") {
			events.push({ type: "error", error: event.error?.message || JSON.stringify(event) });
		}

		// stream_event with text deltas
		if (event.type === "stream_event" && event.event?.delta?.type === "text_delta") {
			events.push({ type: "text_delta", text: event.event.delta.text });
		}

		return events;
	},

	resumeArgs(sessionId: string, correction: string, opts: SpawnOpts): string[] {
		const args = ["-p", correction, "--resume", sessionId, "--output-format", "stream-json"];
		if (opts.model) args.push("--model", opts.model);
		return args;
	},
};
