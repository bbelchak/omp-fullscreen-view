import type { Component, TUI } from "@oh-my-pi/pi-tui";
import {
	type Builder,
	createBuilder,
	isExpandable,
	isPromptEntry,
	isTranscriptEntry,
	promptText,
	recentStart,
	type StreamingMessage,
	streamingEntry,
	type ToolCard,
	toolCardsOf,
	type ToolResultFrame,
	type TranscriptEntry,
} from "./adapter";

export interface Prompt {
	entryId: string;
	text: string;
}

/** A tool call of the current run, as its execution events last reported it. */
export interface LiveTool {
	/** Latest progress frame (`tool_execution_update`). */
	partial?: ToolResultFrame;
	/** Result from `tool_execution_end`, before the session records the tool result entry. */
	final?: ToolResultFrame;
}

export interface ModelDeps {
	ui: TUI;
	cwd: string;
	settings: unknown;
	requestRender: () => void;
	getBranch: () => readonly { type: string; id: string }[];
	/** Tool calls running in this session, keyed by call id; owned by the extension. */
	liveTools: ReadonlyMap<string, LiveTool>;
}

/**
 * The session branch replayed into transcript components.
 *
 * Committed entries are appended one at a time so each top-level block gets a stable key
 * (`<entryId>#<n>`) that survives history loads and full rebuilds; per-block expansion
 * overrides are keyed by it. The reply still streaming lives in a separate tail builder,
 * rebuilt from the latest `message_update` snapshot, until the session records it.
 */
export class TranscriptModel {
	readonly #deps: ModelDeps;
	#entries: TranscriptEntry[] = [];
	/** Index of the first replayed entry; older ones load on demand. */
	#loadedFrom = 0;
	#builder: Builder;
	readonly #tail: Builder;
	#tailShown = false;
	#tailVersion = -1;
	#streaming: StreamingMessage | undefined;
	#streamingVersion = 0;
	#childKeys = new Map<Component, string>();
	#entryChildren = new Map<string, Component[]>();
	#toolCards = new Map<string, ToolCard>();
	readonly #overrides = new Map<string, boolean>();
	#expanded = false;
	#prompts: Prompt[] = [];
	#rows: { width: number; committed: readonly string[]; tail: readonly string[]; all: readonly string[] } | undefined;
	/** Bumped on every full rebuild, so the view can drop row-relative state. */
	generation = 0;

	constructor(deps: ModelDeps, expanded: boolean) {
		this.#deps = deps;
		this.#expanded = expanded;
		this.#builder = this.#createBuilder();
		this.#tail = this.#createBuilder();
		this.#reset(deps.getBranch().filter(isTranscriptEntry), true);
	}

	get prompts(): readonly Prompt[] {
		return this.#prompts;
	}

	/** Older history is still unreplayed. */
	get truncated(): boolean {
		return this.#loadedFrom > 0;
	}

	/** Top-level blocks drawn now, the streaming tail included; the pill counts its growth. */
	get blockCount(): number {
		return this.#builder.container.children.length + (this.#tailShown ? this.#tail.container.children.length : 0);
	}

	setStreaming(message: StreamingMessage | undefined): void {
		this.#streaming = message?.role === "assistant" ? message : undefined;
		this.#streamingVersion++;
	}

	/** Pull new session entries and the streaming snapshot; returns whether anything changed. */
	sync(): boolean {
		const branch = this.#deps.getBranch().filter(isTranscriptEntry);
		const known = this.#entries.length;
		const extendsKnown =
			branch.length >= known && (known === 0 || (branch[0]!.id === this.#entries[0]!.id && branch[known - 1]!.id === this.#entries[known - 1]!.id));
		let changed = false;
		if (!extendsKnown) {
			this.#reset(branch, true);
			changed = true;
		} else if (branch.length > known) {
			const added = branch.slice(known);
			this.#entries = branch;
			this.#appendEntries(added);
			for (const entry of added) this.#addPrompt(entry);
			changed = true;
		}
		const streaming = this.#streaming;
		if (streaming && !this.#isRecorded(streaming)) {
			if (this.#tailVersion !== this.#streamingVersion || !this.#tailShown) {
				this.#tail.rebuild([streamingEntry(streaming)]);
				this.#tailVersion = this.#streamingVersion;
				this.#tailShown = true;
				changed = true;
			}
		} else if (this.#tailShown) {
			this.#tail.rebuild([]);
			this.#tailShown = false;
			changed = true;
		}
		return changed;
	}

	/** Replay the whole branch; returns whether there was older history to load. */
	loadOlder(): boolean {
		if (this.#loadedFrom === 0) return false;
		this.#reset(this.#entries, false);
		return true;
	}

	/** Mirror omp's Ctrl+O state; per-block overrides keep their own state. */
	setGlobalExpanded(expanded: boolean): boolean {
		if (expanded === this.#expanded) return false;
		this.#expanded = expanded;
		this.#builder.setExpanded(expanded);
		this.#tail.setExpanded(expanded);
		for (const [child, key] of this.#childKeys) {
			const override = this.#overrides.get(key);
			if (override !== undefined && isExpandable(child)) child.setExpanded(override);
		}
		return true;
	}

	/** Flip one committed block's expansion; false when it cannot expand. */
	toggle(child: Component): boolean {
		const key = this.#childKeys.get(child);
		if (key === undefined || !isExpandable(child)) return false;
		const next = !(this.#overrides.get(key) ?? this.#expanded);
		this.#overrides.set(key, next);
		child.setExpanded(next);
		return true;
	}

	/** Body rows at `width`: committed blocks, then the streaming tail after a blank row. */
	rows(width: number): { all: readonly string[]; committed: number } {
		const committed = this.#builder.container.render(width);
		const tail = this.#tailShown ? this.#tail.container.render(width) : [];
		const cached = this.#rows;
		if (cached && cached.width === width && cached.committed === committed && cached.tail === tail) {
			return { all: cached.all, committed: committed.length };
		}
		const all = tail.length > 0 && committed.length > 0 ? [...committed, "", ...tail] : tail.length > 0 ? tail : committed;
		this.#rows = { width, committed, tail, all };
		return { all, committed: committed.length };
	}

	/** Committed block drawn at body `row` (valid after `rows()` at the current width). */
	childAt(row: number): Component | undefined {
		const container = this.#builder.container;
		let found: Component | undefined;
		for (const child of container.children) {
			const start = container.getChildStartRow(child);
			if (start === undefined) continue;
			if (start > row) break;
			found = child;
		}
		return found;
	}

	childStartRow(child: Component): number | undefined {
		return this.#builder.container.getChildStartRow(child);
	}

	/** Body row where a prompt starts, `undefined` while its history is unloaded. */
	promptRow(prompt: Prompt): number | undefined {
		const first = this.#entryChildren.get(prompt.entryId)?.[0];
		return first ? this.#builder.container.getChildStartRow(first) : undefined;
	}

	dispose(): void {
		this.#builder.dispose();
		this.#tail.dispose();
	}

	#createBuilder(): Builder {
		const builder = createBuilder(this.#deps.ui, this.#deps.cwd, this.#deps.settings, this.#deps.requestRender);
		builder.setExpanded(this.#expanded);
		return builder;
	}

	#reset(entries: TranscriptEntry[], lazy: boolean): void {
		this.#builder.dispose();
		this.#builder = this.#createBuilder();
		this.#entries = entries;
		this.#loadedFrom = lazy ? recentStart(entries) : 0;
		this.#childKeys = new Map();
		this.#entryChildren = new Map();
		this.#toolCards = new Map();
		this.#appendEntries(entries.slice(this.#loadedFrom));
		this.#prompts = [];
		for (const entry of entries) this.#addPrompt(entry);
		if (lazy) this.generation++;
	}

	#appendEntries(entries: TranscriptEntry[]): void {
		const children = this.#builder.container.children;
		for (const entry of entries) {
			const before = children.length;
			this.#builder.append([entry]);
			// A later entry can fold into an earlier block (a tool result into its card) or
			// replace one (a resolved poll), so key only blocks never seen before.
			const added: Component[] = [];
			for (let index = Math.max(0, before - 2); index < children.length; index++) {
				const child = children[index]!;
				if (!this.#childKeys.has(child)) added.push(child);
			}
			if (added.length === 0) continue;
			this.#entryChildren.set(entry.id, added);
			for (const [id, card] of toolCardsOf(entry, added)) {
				this.#toolCards.set(id, card);
				this.#applyLiveTool(id, card);
			}
			for (const [index, child] of added.entries()) {
				const key = `${entry.id}#${index}`;
				this.#childKeys.set(child, key);
				const override = this.#overrides.get(key);
				if (override !== undefined && isExpandable(child)) child.setExpanded(override);
			}
		}
	}

	/** Show a running tool's latest frame on its card, as omp's live transcript does. */
	refreshTool(toolCallId: string): void {
		const card = this.#toolCards.get(toolCallId);
		if (!card) return;
		this.#applyLiveTool(toolCallId, card);
		this.#deps.requestRender();
	}

	#applyLiveTool(toolCallId: string, card: ToolCard): void {
		const live = this.#deps.liveTools.get(toolCallId);
		if (!live) return;
		card.setExecutionStarted(toolCallId);
		if (live.final) card.updateResult(live.final, false, toolCallId);
		else if (live.partial) card.updateResult(live.partial, true, toolCallId);
	}

	#addPrompt(entry: TranscriptEntry): void {
		if (isPromptEntry(entry)) this.#prompts.push({ entryId: entry.id, text: promptText(entry) });
	}

	#isRecorded(message: StreamingMessage): boolean {
		for (let index = this.#entries.length - 1; index >= Math.max(0, this.#entries.length - 8); index--) {
			const entry = this.#entries[index]!;
			if (entry.type !== "message") continue;
			const recorded = entry.message;
			if (recorded.role === "assistant" && recorded.timestamp === message.timestamp) return true;
		}
		return false;
	}
}
