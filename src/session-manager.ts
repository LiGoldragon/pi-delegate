/**
 * Session lifecycle management
 *
 * Spawns CLI subprocesses, parses their streaming output through the
 * appropriate adapter, and tracks session state.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
	type AgentAdapter,
	type AgentId,
	type NormalizedEvent,
	type Session,
	type SpawnOpts,
	MAX_EVENTS_PER_SESSION,
	emptyUsage,
} from "./types.js";
import { claude } from "./adapters/claude.js";
import { gemini } from "./adapters/gemini.js";
import { codex } from "./adapters/codex.js";
import { pi } from "./adapters/pi.js";

const adapters: Record<AgentId, AgentAdapter> = { claude, gemini, codex, pi };

let nextId = 0;

function makeSessionId(agent: AgentId): string {
	return `${agent}-${++nextId}`;
}

export type OnSessionUpdate = (session: Session, allSessions: Session[]) => void;

export class SessionManager {
	private sessions = new Map<string, Session>();
	private processes = new Map<string, ChildProcess>();
	private cachedList: Session[] | null = null;

	getAdapter(agent: AgentId): AgentAdapter {
		return adapters[agent];
	}

	listSessions(): Session[] {
		if (!this.cachedList) {
			this.cachedList = Array.from(this.sessions.values());
		}
		return this.cachedList;
	}

	private invalidateCache(): void {
		this.cachedList = null;
	}

	getSession(id: string): Session | undefined {
		return this.sessions.get(id);
	}

	async spawn(
		agent: AgentId,
		opts: SpawnOpts,
		onUpdate?: OnSessionUpdate,
	): Promise<Session> {
		const adapter = adapters[agent];
		const id = makeSessionId(agent);
		const args = adapter.spawnArgs(opts);

		const session: Session = {
			id,
			agent,
			task: opts.task,
			cwd: opts.cwd,
			status: "running",
			events: [],
			outputChunks: [],
			output: "",
			usage: emptyUsage(),
			model: opts.model,
		};
		this.sessions.set(id, session);
		this.invalidateCache();

		await this.runProcess(adapter, args, session, opts.cwd, opts.signal, onUpdate);
		return session;
	}

	kill(id: string): boolean {
		const proc = this.processes.get(id);
		const session = this.sessions.get(id);
		if (!proc || !session) return false;

		session.status = "killed";
		proc.kill("SIGTERM");
		setTimeout(() => {
			if (!proc.killed) proc.kill("SIGKILL");
		}, 5000);
		return true;
	}

	async resume(
		id: string,
		correction: string,
		onUpdate?: OnSessionUpdate,
	): Promise<Session | null> {
		const original = this.sessions.get(id);
		if (!original) return null;

		const adapter = adapters[original.agent];
		const resumeArgs = adapter.resumeArgs(
			original.sessionId || id,
			correction,
			{ task: correction, model: original.model, cwd: original.cwd },
		);

		if (!resumeArgs) return null;

		const newId = makeSessionId(original.agent);
		const session: Session = {
			id: newId,
			agent: original.agent,
			task: `[resume] ${correction}`,
			cwd: original.cwd,
			status: "running",
			events: [],
			outputChunks: [],
			output: "",
			usage: emptyUsage(),
			model: original.model,
		};
		this.sessions.set(newId, session);
		this.invalidateCache();

		await this.runProcess(adapter, resumeArgs, session, original.cwd, undefined, onUpdate);
		return session;
	}

	/** Shared subprocess lifecycle: spawn, stream, parse, track */
	private async runProcess(
		adapter: AgentAdapter,
		args: string[],
		session: Session,
		cwd: string | undefined,
		signal: AbortSignal | undefined,
		onUpdate: OnSessionUpdate | undefined,
	): Promise<void> {
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(adapter.bin, args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			session.pid = proc.pid;
			this.processes.set(session.id, proc);

			let buffer = "";

			const processLine = (line: string) => {
				const normalized = adapter.parseLine(line);
				for (const ev of normalized) {
					if (session.events.length < MAX_EVENTS_PER_SESSION) {
						session.events.push(ev);
					}
					this.applyEvent(session, ev);
				}
				if (normalized.length > 0 && onUpdate) {
					onUpdate(session, this.listSessions());
				}
			};

			proc.stdout!.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr!.on("data", () => {});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				this.processes.delete(session.id);
				resolve(code ?? 0);
			});

			proc.on("error", (err) => {
				session.status = "error";
				session.events.push({ type: "error", error: err.message });
				this.processes.delete(session.id);
				resolve(1);
			});

			if (signal) {
				const kill = () => {
					session.status = "killed";
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) kill();
				else signal.addEventListener("abort", kill, { once: true });
			}
		});

		session.exitCode = exitCode;
		if (session.status === "running") {
			session.status = exitCode === 0 ? "done" : "error";
		}
		// Finalize output from chunks
		session.output = session.outputChunks.join("");

		if (onUpdate) onUpdate(session, this.listSessions());
	}

	private applyEvent(session: Session, ev: NormalizedEvent): void {
		if (ev.type === "text_delta" && ev.text) {
			session.outputChunks.push(ev.text);
		}
		if (ev.type === "done") {
			if (ev.sessionId) session.sessionId = ev.sessionId;
			// done.text is the authoritative final output if present
			if (ev.text) {
				session.outputChunks = [ev.text];
			}
			if (ev.usage) session.usage = ev.usage;
		}
		if (ev.type === "usage" && ev.usage) {
			session.usage.input += ev.usage.input;
			session.usage.output += ev.usage.output;
			session.usage.cacheRead += ev.usage.cacheRead;
			session.usage.cacheWrite += ev.usage.cacheWrite;
			session.usage.cost += ev.usage.cost;
			session.usage.turns += ev.usage.turns;
		}
	}
}
