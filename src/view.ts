import { theme } from "@oh-my-pi/pi-coding-agent";
import {
	type Component,
	matchesKey,
	parseSgrMouse,
	type SgrMouseEvent,
	sliceByColumn,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { type RailLine, railLines, scrollbarThumb, type Thumb, topForThumb } from "./layout";
import type { TranscriptModel } from "./model";
import type { ViewSettings } from "./settings";

const RESET = "\x1b[0m";
/** Below this width the rail is hidden and the transcript gets its columns back. */
const RAIL_MIN_WIDTH = 40;
/** Switches between fullscreen and the classic screen. Ctrl+X belongs to omp's autoresearch. */
export const TOGGLE_KEY = "alt+s";
const CARD_MAX_WIDTH = 56;
const WHEEL_ROWS = 3;

export interface ViewDeps {
	tui: TUI;
	model: TranscriptModel;
	settings: ViewSettings;
	/** omp's bottom chrome to draw under the transcript; absent in the read-only fallback. */
	chrome?: () => readonly Component[];
	/** Where keyboard focus belongs while the chrome is borrowed (omp's editor). */
	focusTarget?: Component;
	onClose: () => void;
}

interface Layout {
	width: number;
	/** Transcript rows (screen rows above the chrome). */
	rows: number;
	contentWidth: number;
	railOn: boolean;
	total: number;
	committed: number;
	pill?: { col: number; width: number };
	header?: { width: number; target: number };
	rail: RailLine[];
	scrollbar?: Thumb;
}

/**
 * The fullscreen transcript: a virtualised body above omp's own chrome, with a jump pill,
 * a sticky prompt header, a prompt rail and a scrollbar. Deliberately has no `handleInput`:
 * keys reach omp's focused component, and the extension routes the view's own keys and
 * mouse reports through {@link route} from a terminal input listener.
 */
export class FullscreenView implements Component {
	readonly #deps: ViewDeps;
	#top = 0;
	#following = true;
	/** Block count when following stopped; the pill counts blocks added since. */
	#snapshot = 0;
	#generation = -1;
	#hover: { row: number; col: number } | undefined;
	#drag: { grab: number } | undefined;
	#layout: Layout | undefined;

	constructor(deps: ViewDeps) {
		this.#deps = deps;
	}

	/** Focus may move into the borrowed chrome (the editor, its dialogs) without leaving the overlay. */
	ownsOverlayFocusTarget(_component: Component): boolean {
		return this.#deps.chrome !== undefined;
	}

	invalidate(): void {
		this.#layout = undefined;
	}

	/** Handle a view key or mouse report; false leaves it to omp. */
	route(data: string): boolean {
		if (data.startsWith("\x1b[<")) {
			const event = parseSgrMouse(data);
			if (!event) return false;
			this.#mouse(event);
			return true;
		}
		const half = Math.max(1, Math.floor((this.#layout?.rows ?? 2) / 2));
		if (matchesKey(data, "pageUp")) this.#setTop(this.#top - half);
		else if (matchesKey(data, "pageDown")) this.#setTop(this.#top + half);
		else if (matchesKey(data, "ctrl+home")) {
			this.#deps.model.loadOlder();
			this.#setTop(0);
		} else if (matchesKey(data, "ctrl+end")) this.#jumpToBottom();
		else if (matchesKey(data, TOGGLE_KEY)) this.#deps.onClose();
		else return false;
		return true;
	}

	render(width: number): readonly string[] {
		const { tui, model, settings, focusTarget } = this.#deps;
		if (focusTarget && tui.getFocused() === this) queueMicrotask(() => tui.setFocus(focusTarget));
		if (model.generation !== this.#generation) {
			this.#generation = model.generation;
			this.#following = true;
		}

		const height = Math.max(1, tui.terminal.rows);
		const chrome: string[] = [];
		if (this.#deps.chrome) {
			for (const child of this.#deps.chrome()) chrome.push(...child.render(width));
		} else {
			chrome.push(theme.fg("dim", " Read-only view · PgUp/PgDn scroll · Esc or Alt+S close"));
		}
		const maxChrome = Math.max(0, height - 3);
		if (chrome.length > maxChrome) chrome.splice(0, chrome.length - maxChrome);
		const rows = height - chrome.length;
		const railOn = settings.rail && width >= RAIL_MIN_WIDTH;
		const contentWidth = Math.max(1, width - (railOn ? 3 : 1));

		let body = model.rows(contentWidth);
		if (!this.#following && this.#top <= 0 && model.truncated) {
			// Older history replays above the rows in view, which stay where they are.
			const before = body.all.length;
			model.loadOlder();
			body = model.rows(contentWidth);
			this.#top += body.all.length - before;
		}
		const total = body.all.length;
		const maxTop = Math.max(0, total - rows);
		this.#top = this.#following ? maxTop : Math.max(0, Math.min(maxTop, this.#top));
		const top = this.#top;

		const layout: Layout = { width, rows, contentWidth, railOn, total, committed: body.committed, rail: [] };
		const hover = this.#hover;
		const lines: string[] = [];
		for (let row = 0; row < rows; row++) lines.push(truncateToWidth(body.all[top + row] ?? "", contentWidth, "", true));

		// Prompt rows; prompts whose history is not loaded yet sit above everything loaded.
		const prompts = model.prompts;
		const promptRows = prompts.map(prompt => model.promptRow(prompt));

		// Sticky header: the latest prompt at or above the top row, when its own first row is out of sight.
		if (!this.#following && rows > 1) {
			let index = promptRows.length - 1;
			while (index >= 0 && (promptRows[index] === undefined || promptRows[index]! > top)) index--;
			const target = promptRows[index];
			if (target !== undefined && target < top) {
				const label = truncateToWidth(` ↑ ${prompts[index]!.text} `, contentWidth, "…");
				const labelWidth = visibleWidth(label);
				const hot = hover !== undefined && hover.row === 0 && hover.col < labelWidth;
				const styled = hot ? theme.underline(theme.fg("accent", label)) : theme.fg("dim", label);
				lines[0] = `${styled}${RESET}${" ".repeat(Math.max(0, contentWidth - labelWidth))}`;
				layout.header = { width: labelWidth, target };
			}
		}

		// Jump pill, centred on the last transcript row.
		if (!this.#following) {
			const added = Math.max(0, model.blockCount - this.#snapshot);
			const label =
				added > 0 ? ` ↓ Jump to bottom · ${added} new message${added === 1 ? "" : "s"} ` : " ↓ Jump to bottom ";
			const labelWidth = Math.min(contentWidth, visibleWidth(label));
			const col = Math.max(0, Math.floor((contentWidth - labelWidth) / 2));
			const row = rows - 1;
			const hot = hover !== undefined && hover.row === row && hover.col >= col && hover.col < col + labelWidth;
			const text = truncateToWidth(label, labelWidth, "");
			const styled = hot
				? theme.inverse(theme.bold(theme.fg("accent", text)))
				: theme.bg("selectedBg", theme.fg("accent", text));
			lines[row] = splice(lines[row]!, col, styled, labelWidth, contentWidth);
			layout.pill = { col, width: labelWidth };
		}

		// Prompt rail.
		const railGlyphs: string[] = Array(rows).fill(" ");
		if (railOn && prompts.length > 0) {
			layout.rail = railLines(prompts.length, rows);
			const threshold = top + Math.ceil(rows / 2);
			let current = promptRows.length - 1;
			while (current > 0 && promptRows[current] !== undefined && promptRows[current]! >= threshold) current--;
			const onRail = hover !== undefined && (hover.col === contentWidth || hover.col === contentWidth + 1);
			const hovered = onRail ? layout.rail.find(line => line.row === hover.row) : undefined;
			for (const line of layout.rail) {
				if (line.row < 0 || line.row >= rows) continue;
				railGlyphs[line.row] =
					current >= line.first && current <= line.last
						? theme.bold(theme.fg("accent", "━"))
						: line === hovered
							? theme.fg("text", "━")
							: theme.fg("dim", "─");
			}
			if (hovered) {
				const range = hovered.first === hovered.last ? `#${hovered.first + 1}` : `#${hovered.first + 1}–${hovered.last + 1}`;
				const card = truncateToWidth(
					` ${range}  ${prompts[hovered.first]!.text} `,
					Math.min(CARD_MAX_WIDTH, contentWidth),
					"…",
				);
				const cardWidth = visibleWidth(card);
				lines[hovered.row] = splice(
					lines[hovered.row]!,
					contentWidth - cardWidth,
					theme.bg("selectedBg", theme.fg("text", card)),
					cardWidth,
					contentWidth,
				);
			}
		}

		// Scrollbar in the last column.
		const scrollbarCol = width - 1;
		const showScrollbar =
			total > rows &&
			(!this.#following ||
				this.#drag !== undefined ||
				(hover !== undefined && hover.col === scrollbarCol && hover.row < rows));
		const thumb = showScrollbar ? scrollbarThumb(total, rows, top) : undefined;
		layout.scrollbar = thumb;

		const output: string[] = [];
		for (let row = 0; row < rows; row++) {
			const bar = thumb
				? row >= thumb.start && row < thumb.start + thumb.size
					? theme.fg("accent", "┃")
					: theme.fg("dim", "│")
				: " ";
			output.push(`${lines[row]}${RESET}${railOn ? ` ${railGlyphs[row]}` : ""}${bar}${RESET}`);
		}
		output.push(...chrome);
		this.#layout = layout;
		return output;
	}

	#mouse(event: SgrMouseEvent): void {
		const layout = this.#layout;
		if (!layout) return;
		// Every report carries the pointer position; a click without motion (a test harness,
		// a touchpad tap) still moves the hover.
		this.#hover = { row: event.row, col: event.col };
		if (event.wheel !== null) {
			this.#setTop(this.#top + event.wheel * WHEEL_ROWS);
			return;
		}
		if (event.release) {
			if (this.#drag) {
				this.#drag = undefined;
				this.#deps.tui.requestRender();
			}
			return;
		}
		if (event.motion) {
			if (this.#drag && layout.scrollbar) {
				this.#setTop(topForThumb(event.row - this.#drag.grab, layout.scrollbar, layout.total, layout.rows));
				return;
			}
			this.#deps.tui.requestRender();
			return;
		}
		if (!event.leftClick || event.row >= layout.rows) return;
		const { row, col } = event;

		const thumb = layout.scrollbar;
		if (thumb && col === layout.width - 1) {
			if (row >= thumb.start && row < thumb.start + thumb.size) {
				this.#drag = { grab: row - thumb.start };
			} else {
				const grab = Math.floor(thumb.size / 2);
				this.#drag = { grab };
				this.#setTop(topForThumb(row - grab, thumb, layout.total, layout.rows));
			}
			this.#deps.tui.requestRender();
			return;
		}
		const pill = layout.pill;
		if (pill && row === layout.rows - 1 && col >= pill.col && col < pill.col + pill.width) {
			this.#jumpToBottom();
			return;
		}
		if (layout.header && row === 0 && col < layout.header.width) {
			this.#setTop(layout.header.target);
			return;
		}
		if (layout.railOn && (col === layout.contentWidth || col === layout.contentWidth + 1)) {
			const line = layout.rail.find(candidate => candidate.row === row);
			if (line) this.#jumpToPrompt(line.first);
			return;
		}
		if (col < layout.contentWidth) this.#toggleAt(this.#top + row);
	}

	/**
	 * Expand or collapse the block under a click. Rows above the block's first row do not
	 * change, so with the same top row it stays where it is on screen.
	 */
	#toggleAt(bodyRow: number): void {
		const layout = this.#layout!;
		if (bodyRow >= layout.committed) return;
		const { model } = this.#deps;
		const child = model.childAt(bodyRow);
		if (!child || !model.toggle(child)) return;
		if (!this.#following) this.#setTop(this.#top);
		this.#deps.tui.requestRender();
	}

	#jumpToPrompt(index: number): void {
		const { model } = this.#deps;
		const prompt = model.prompts[index];
		if (!prompt) return;
		let row = model.promptRow(prompt);
		if (row === undefined && model.loadOlder()) {
			model.rows(this.#layout!.contentWidth);
			row = model.promptRow(prompt);
		}
		if (row !== undefined) this.#setTop(row);
	}

	#jumpToBottom(): void {
		this.#following = true;
		this.#deps.tui.requestRender();
	}

	/** Scroll to `top`; reaching the bottom resumes following, leaving it stops. */
	#setTop(top: number): void {
		const layout = this.#layout;
		if (!layout) return;
		const total = this.#deps.model.rows(layout.contentWidth).all.length;
		const maxTop = Math.max(0, total - layout.rows);
		this.#top = Math.max(0, Math.min(maxTop, Math.round(top)));
		const following = this.#top >= maxTop;
		if (this.#following && !following) this.#snapshot = this.#deps.model.blockCount;
		this.#following = following;
		this.#deps.tui.requestRender();
	}
}

/** Paint `text` (`textWidth` columns) over `line` at `col`, keeping the line `width` wide. */
function splice(line: string, col: number, text: string, textWidth: number, width: number): string {
	const start = Math.max(0, Math.min(col, width - textWidth));
	const before = sliceByColumn(line, 0, start);
	const after = sliceByColumn(line, start + textWidth, Math.max(0, width - start - textWidth));
	return `${before}${RESET}${text}${RESET}${after}`;
}
