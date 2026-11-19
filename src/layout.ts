/** One rail line: the prompts it stands for and the screen row it sits on. */
export interface RailLine {
	first: number;
	last: number;
	row: number;
}

/**
 * Rail lines for `prompts` prompts in a transcript area `rows` tall, centred vertically.
 * With more prompts than lines, neighbours share a line.
 */
export function railLines(prompts: number, rows: number): RailLine[] {
	const count = Math.min(prompts, Math.max(1, rows - 2));
	const top = Math.floor((rows - count) / 2);
	const lines: RailLine[] = [];
	for (let i = 0; i < count; i++) {
		const first = Math.floor((i * prompts) / count);
		const last = Math.max(first, Math.floor(((i + 1) * prompts) / count) - 1);
		lines.push({ first, last, row: top + i });
	}
	return lines;
}

export interface Thumb {
	start: number;
	size: number;
}

/** Scrollbar thumb for `total` body rows shown `height` at a time from row `top`. */
export function scrollbarThumb(total: number, height: number, top: number): Thumb {
	const size = Math.max(1, Math.min(height, Math.round((height * height) / Math.max(1, total))));
	const maxTop = Math.max(0, total - height);
	const start = maxTop > 0 ? Math.round((top / maxTop) * (height - size)) : 0;
	return { start, size };
}

/** Inverse of {@link scrollbarThumb}: the top row that puts the thumb at `start`. */
export function topForThumb(start: number, thumb: Thumb, total: number, height: number): number {
	const travel = height - thumb.size;
	const maxTop = Math.max(0, total - height);
	if (travel <= 0) return 0;
	return Math.round((Math.max(0, Math.min(travel, start)) / travel) * maxTop);
}
