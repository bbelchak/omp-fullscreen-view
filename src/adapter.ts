/**
 * Every dependency on omp internals lives here. These deep imports and private layout
 * assumptions are not a public API: when an omp update breaks one, fix this file.
 * `selfCheck` runs before each mount; when it fails, the view falls back to a read-only
 * overlay without the borrowed chrome and says why.
 *
 * Verified against omp 19.0.0.
 */
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { readArgsCollapseIntoGroup } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { ReplyWriteComponent } from "@oh-my-pi/pi-tui/chat/reply-write";
import { ToolExecutionComponent, type ToolResultFrame } from "@oh-my-pi/pi-tui/chat/tool-execution";
import {
	isUserRequestEntry,
	recentTranscriptEntries,
	type TranscriptEntryLike,
	userTurnDraft,
} from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line/component";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";

export type TranscriptEntry = TranscriptEntryLike;
export type { ToolResultFrame };

/** A tool card that takes progress frames, as omp's live transcript feeds them. */
export interface ToolCard extends Component {
	setExecutionStarted(toolCallId?: string): void;
	updateResult(result: ToolResultFrame, isPartial?: boolean, toolCallId?: string): void;
}

/**
 * The tool cards appending `entry` created, keyed by tool call id. Cards keep their call
 * id private, so calls and cards are paired in order: the builder makes one card per call,
 * except reads that fold into a shared read group. When the counts disagree nothing is
 * paired, so a frame never lands on the wrong card.
 */
export function toolCardsOf(entry: TranscriptEntry, added: readonly Component[]): Map<string, ToolCard> {
	const cards = new Map<string, ToolCard>();
	if (entry.type !== "message" || entry.message.role !== "assistant") return cards;
	const calls: string[] = [];
	for (const block of entry.message.content) {
		if (block.type !== "toolCall") continue;
		if (block.name === "read" && readArgsCollapseIntoGroup(block.arguments)) continue;
		calls.push(block.id);
	}
	const made = added.filter(
		(child): child is ToolCard => child instanceof ToolExecutionComponent || child instanceof ReplyWriteComponent,
	);
	if (made.length !== calls.length) return cards;
	for (const [index, id] of calls.entries()) cards.set(id, made[index]!);
	return cards;
}

/** The slice of `ChatTranscriptBuilder` the view relies on. */
export interface Builder {
	readonly container: {
		readonly children: readonly Component[];
		render(width: number): readonly string[];
		getChildStartRow(child: Component): number | undefined;
	};
	rebuild(entries: TranscriptEntry[]): void;
	append(entries: TranscriptEntry[]): void;
	setExpanded(expanded: boolean): void;
	dispose(): void;
}

/** A transcript block whose detail can be toggled (tool cards, thinking, summaries, …). */
export interface Expandable extends Component {
	setExpanded(expanded: boolean): void;
}

export function isExpandable(component: Component): component is Expandable {
	return typeof (component as Partial<Expandable>).setExpanded === "function";
}

/** Settings handle values read through the public registry subpath, `undefined` when absent. */
function setting(scope: unknown, id: string): boolean | undefined {
	const get = field(lookup(id), "get");
	if (typeof get !== "function") return undefined;
	const value: unknown = Reflect.apply(get, lookup(id), [scope]);
	return typeof value === "boolean" ? value : undefined;
}

export function createBuilder(ui: TUI, cwd: string, settings: unknown, requestRender: () => void): Builder {
	return new ChatTranscriptBuilder({
		ui,
		cwd,
		hideThinkingBlock: () => setting(settings, "hideThinkingBlock") ?? false,
		proseOnlyThinking: () => setting(settings, "proseOnlyThinking") ?? false,
		expandThinkingBlocks: () => setting(settings, "expandThinkingBlocks") ?? false,
		requestRender,
	}) as unknown as Builder;
}

/** Session entries the transcript draws (the same filter omp's link browser applies). */
export function isTranscriptEntry(entry: { type: string }): entry is TranscriptEntry {
	return entry.type === "message" || entry.type === "custom_message";
}

export function isPromptEntry(entry: TranscriptEntry): boolean {
	return isUserRequestEntry(entry);
}

/** One-line prompt text with whitespace collapsed. */
export function promptText(entry: TranscriptEntry): string {
	return (userTurnDraft(entry) ?? "").replace(/\s+/g, " ").trim();
}

/** Index where the recent part of a long branch starts (always a prompt boundary). */
export function recentStart(entries: TranscriptEntry[]): number {
	return entries.length - recentTranscriptEntries(entries).length;
}

/** A transcript entry for the reply still streaming, which the session has not recorded yet. */
export function streamingEntry(message: { timestamp: number }): TranscriptEntry {
	return {
		type: "message",
		id: "omp-fullscreen-view:streaming",
		parentId: null,
		timestamp: new Date(message.timestamp).toISOString(),
		message: message as never,
	};
}

/**
 * The bottom chrome of the interactive TUI: every root child after the main transcript
 * container (queued messages, HUDs, status, the editor and its dialogs, the status line).
 */
export function chromeChildren(tui: TUI): Component[] {
	const children = field(tui, "children");
	if (!Array.isArray(children)) return [];
	const index = children.findIndex(child => child instanceof TranscriptContainer);
	return index < 0 ? [] : children.slice(index + 1);
}

/** A reply as streaming events carry it. */
export interface StreamingMessage {
	role: string;
	timestamp: number;
}

/** The session events the view follows, shaped as both extension and session events carry them. */
export type SessionEvent =
	| { type: "message_update"; message: StreamingMessage }
	| { type: "agent_end" }
	| { type: "tool_execution_start"; toolCallId: string }
	| { type: "tool_execution_update"; toolCallId: string; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; result: unknown; isError: boolean };

const SESSION_EVENTS: Record<SessionEvent["type"], true> = {
	message_update: true,
	agent_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
};

/** A session omp's TUI shows: the main one, or a subagent's while it is focused. */
export interface ViewedSession {
	readonly id: string;
	getBranch(): readonly { type: string; id: string }[];
	/** The reply streaming right now, if any. */
	streaming(): StreamingMessage | undefined;
	subscribe(listener: (event: SessionEvent) => void): () => void;
}

/**
 * The session omp's TUI shows now, `undefined` when it cannot be found. Focusing a subagent
 * (Agent Hub, a card click) points the transcript, editor and status line at the agent's
 * session without any extension event. The status line keeps that session as `session`,
 * and the prompt editor keeps the status line as `composerFacts`.
 */
export function viewedSession(tui: TUI): ViewedSession | undefined {
	const session = field(findStatusLine(chromeChildren(tui)), "session");
	const manager = field(session, "sessionManager");
	const getBranch = field(manager, "getBranch");
	const getSessionId = field(manager, "getSessionId");
	const subscribe = field(session, "subscribe");
	if (typeof getBranch !== "function" || typeof getSessionId !== "function" || typeof subscribe !== "function") {
		return undefined;
	}
	const id: unknown = Reflect.apply(getSessionId, manager, []);
	if (typeof id !== "string") return undefined;
	return {
		id,
		getBranch: () => Reflect.apply(getBranch, manager, []),
		streaming: () => {
			const message = field(field(field(session, "agent"), "state"), "streamMessage");
			return typeof field(message, "role") === "string" && typeof field(message, "timestamp") === "number"
				? (message as StreamingMessage)
				: undefined;
		},
		subscribe: listener =>
			Reflect.apply(subscribe, session, [
				(event: unknown) => {
					const type = field(event, "type");
					if (typeof type === "string" && Object.hasOwn(SESSION_EVENTS, type)) listener(event as SessionEvent);
				},
			]),
	};
}

function findStatusLine(components: readonly unknown[]): StatusLineComponent | undefined {
	for (const component of components) {
		if (component instanceof StatusLineComponent) return component;
		const facts = field(component, "composerFacts");
		if (facts instanceof StatusLineComponent) return facts;
		const children = field(component, "children");
		const found = Array.isArray(children) ? findStatusLine(children) : undefined;
		if (found) return found;
	}
	return undefined;
}

/**
 * Whether omp sizes its frames differently from the pty. omp prefers DEC 2048 in-band resize
 * reports over the pty size and drops a report that disagrees only on the next SIGWINCH. Herdr
 * sends a report when a terminal shrinks for a peek but none when it returns to its pane, so a
 * peek report read late leaves every frame short, over stale rows of the last full one, until
 * the window is resized. Temporary: remove once omp drops such reports itself in Herdr desktop
 * terminals (fix submitted upstream to can1357/oh-my-pi) and Herdr reports every resize.
 */
export function terminalSizeStale(tui: TUI): boolean {
	const { rows, columns } = process.stdout;
	return rows > 0 && columns > 0 && (tui.terminal.rows !== rows || tui.terminal.columns !== columns);
}

/** Replay the pty resize event: omp drops the disagreeing in-band size and repaints at the real one. */
export function reconcileTerminalSize(): void {
	process.stdout.emit("resize");
}

/** Read a member of an internal object through a runtime guard instead of a trusted shape. */
function field(value: unknown, key: string): unknown {
	if ((typeof value !== "object" && typeof value !== "function") || value === null || !(key in value)) return undefined;
	return Reflect.get(value, key);
}

/** Why borrowing omp's chrome cannot work on this build, or `undefined` when it can. */
export function selfCheck(tui: TUI): string | undefined {
	if (typeof field(tui, "getFocused") !== "function" || typeof field(tui, "setFocus") !== "function") {
		return "TUI.getFocused/setFocus missing";
	}
	if (typeof field(field(tui, "terminal"), "rows") !== "number") return "TUI.terminal.rows missing";
	const children = field(tui, "children");
	if (!Array.isArray(children)) return "TUI root children missing";
	const transcripts = children.filter(child => child instanceof TranscriptContainer).length;
	if (transcripts !== 1) return `expected one transcript container in the TUI root, found ${transcripts}`;
	if (chromeChildren(tui).length === 0) return "no chrome below the transcript container";
	for (const method of ["append", "rebuild", "setExpanded", "dispose"]) {
		if (typeof field(ChatTranscriptBuilder.prototype, method) !== "function") {
			return `ChatTranscriptBuilder.${method} missing`;
		}
	}
	if (typeof field(TranscriptContainer.prototype, "getChildStartRow") !== "function") {
		return "TranscriptContainer.getChildStartRow missing";
	}
	return undefined;
}
