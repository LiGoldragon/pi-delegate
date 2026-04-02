/**
 * Shared types for pi-delegate
 *
 * Normalizes the heterogeneous JSON streaming formats of Claude, Gemini,
 * Codex, and Pi into a single event model.
 */

export type AgentId = "claude" | "gemini" | "codex" | "pi";

export interface SpawnOpts {
	task: string;
	model?: string;
	cwd?: string;
	signal?: AbortSignal;
}

export interface NormalizedEvent {
	type: "text_delta" | "tool_call" | "tool_result" | "usage" | "error" | "done";
	/** Incremental text from the agent */
	text?: string;
	/** Tool name for tool_call events */
	toolName?: string;
	/** Tool arguments for tool_call events */
	toolArgs?: Record<string, unknown>;
	/** Tool output for tool_result events */
	toolOutput?: string;
	/** Usage stats snapshot */
	usage?: UsageStats;
	/** Error message */
	error?: string;
	/** Session identifier (for resume) */
	sessionId?: string;
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

export interface AdapterResult {
	exitCode: number;
	output: string;
	sessionId?: string;
	usage: UsageStats;
	model?: string;
}

export interface AgentAdapter {
	/** CLI binary name */
	readonly bin: string;
	/** Build spawn arguments for headless execution */
	spawnArgs(opts: SpawnOpts): string[];
	/** Parse one line of stdout into zero or more normalized events */
	parseLine(line: string): NormalizedEvent[];
	/** Build arguments to resume a killed session with a correction */
	resumeArgs(sessionId: string, correction: string, opts: SpawnOpts): string[] | null;
}

export interface Session {
	id: string;
	agent: AgentId;
	task: string;
	status: "running" | "done" | "error" | "killed";
	events: NormalizedEvent[];
	output: string;
	usage: UsageStats;
	sessionId?: string;
	model?: string;
	exitCode?: number;
	pid?: number;
}

export interface DelegateDetails {
	mode: "single" | "parallel";
	sessions: Session[];
}
