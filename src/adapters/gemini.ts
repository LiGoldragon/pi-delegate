/**
 * Gemini CLI adapter
 *
 * Spawns: gemini -p $task -o stream-json
 * Resume: not supported (new session with context)
 */

import type { AgentAdapter, NormalizedEvent, SpawnOpts } from "../types.js";
import { safeParseLine } from "../shared.js";

export const gemini: AgentAdapter = {
	bin: "gemini",

	spawnArgs(opts: SpawnOpts): string[] {
		const args = ["-p", opts.task, "-o", "stream-json"];
		if (opts.model) args.push("-m", opts.model);
		return args;
	},

	parseLine(line: string): NormalizedEvent[] {
		const event = safeParseLine(line);
		if (!event) return [];

		const events: NormalizedEvent[] = [];

		if (event.type === "message" && event.role === "assistant") {
			events.push({ type: "text_delta", text: event.content });
		}

		if (event.type === "tool_use") {
			events.push({
				type: "tool_call",
				toolName: event.name,
				toolArgs: event.arguments,
			});
		}

		if (event.type === "tool_result") {
			events.push({
				type: "tool_result",
				toolName: event.name,
				toolOutput: event.content,
			});
		}

		if (event.type === "result") {
			const stats = event.stats;
			let totalInput = 0;
			let totalOutput = 0;
			let totalCached = 0;
			if (stats?.models) {
				for (const model of Object.values(stats.models) as any[]) {
					totalInput += model.tokens?.input || 0;
					totalOutput += model.tokens?.candidates || 0;
					totalCached += model.tokens?.cached || 0;
				}
			}
			events.push({
				type: "done",
				sessionId: event.session_id,
				usage: {
					input: totalInput,
					output: totalOutput,
					cacheRead: totalCached,
					cacheWrite: 0,
					cost: 0,
					turns: stats?.tools?.totalCalls || 0,
				},
			});
		}

		if (event.type === "init") {
			events.push({ type: "done", sessionId: event.session_id });
		}

		if (event.type === "error") {
			events.push({ type: "error", error: event.message || JSON.stringify(event) });
		}

		return events;
	},

	resumeArgs(_sessionId: string, correction: string, opts: SpawnOpts): string[] | null {
		// Gemini has no resume — start fresh with context
		const args = ["-p", correction, "-o", "stream-json"];
		if (opts.model) args.push("-m", opts.model);
		return args;
	},
};
