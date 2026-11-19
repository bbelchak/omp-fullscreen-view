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
import {
	isUserRequestEntry,
	recentTranscriptEntries,
	type TranscriptEntryLike,
	userTurnDraft,
} from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";

export type TranscriptEntry = TranscriptEntryLike;

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
