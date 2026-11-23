import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type Component, matchesKey, type TUI } from "@oh-my-pi/pi-tui";
import {
	chromeChildren,
	reconcileTerminalSize,
	type SessionEvent,
	type StreamingMessage,
	selfCheck,
	terminalSizeStale,
	type ToolResultFrame,
	type ViewedSession,
	viewedSession,
} from "./adapter";
import { type LiveTool, TranscriptModel } from "./model";
import { loadSettings, saveSettings } from "./settings";
import { FullscreenView, TOGGLE_KEY } from "./view";

const SYNC_MS = 100;

/** One session's reply still streaming and its tool calls running, as its events report them. */
interface LiveState {
	streaming: StreamingMessage | undefined;
	readonly tools: Map<string, LiveTool>;
}

export default function fullscreenView(pi: ExtensionAPI): void {
	const settings = loadSettings();
	/** The user left fullscreen with the toggle key; holds until the next session start or switch. */
	let classic = false;
	/** The main session, fed by extension events whether or not the view shows it. */
	const main: LiveState = { streaming: undefined, tools: new Map() };
	let open:
		| { model: TranscriptModel; live: LiveState; close: () => void; requestRender: () => void }
		| undefined;
	let mounting = false;
	/** A session switch or focus change arrived while the old view was open: reopen once it has closed. */
	let reopenWith: ExtensionContext | undefined;

	/** The subagent session omp's TUI is focused on, `undefined` while it shows the main session. */
	function focusedSession(tui: TUI, ctx: ExtensionContext): ViewedSession | undefined {
		const viewed = viewedSession(tui);
		return viewed && viewed.id !== ctx.sessionManager.getSessionId() ? viewed : undefined;
	}

	function show(ctx: ExtensionContext): void {
		if (open || mounting || classic || ctx.mode !== "tui" || !ctx.hasUI || ctx.agent.kind !== "main") return;
		mounting = true;
		let unsubscribe: (() => void) | undefined;
		let unfollow: (() => void) | undefined;
		let timer: Timer | undefined;
		void ctx.ui
			.custom<void>(
				(tui, _theme, _keybindings, done) => {
					const problem = selfCheck(tui);
					if (problem) {
						ctx.ui.notify(`Fullscreen view: omp internals changed (${problem}); showing a read-only view`, "warning");
					} else if (!viewedSession(tui)) {
						ctx.ui.notify("Fullscreen view: cannot find the session omp shows; focused subagents will not appear", "warning");
					}
					const focused = focusedSession(tui, ctx);
					const live: LiveState = focused ? { streaming: focused.streaming(), tools: new Map() } : main;
					const model = new TranscriptModel(
						{
							ui: tui,
							cwd: ctx.cwd,
							settings: pi.pi.settings,
							requestRender: () => tui.requestRender(),
							getBranch: focused ? () => focused.getBranch() : () => ctx.sessionManager.getBranch(),
							liveTools: live.tools,
						},
						ctx.ui.getToolsExpanded(),
					);
					model.setStreaming(live.streaming);
					model.sync();
					unfollow = focused?.subscribe(event => feed(live, event, model));
					const close = () => {
						classic = true;
						done(undefined);
					};
					const view = new FullscreenView({
						tui,
						model,
						settings,
						chrome: problem ? undefined : () => chromeChildren(tui),
						focusTarget: problem ? undefined : (tui.getFocused() ?? undefined),
						onClose: close,
					});
					/** Consecutive ticks omp's frame size disagreed with the pty. */
					let staleTicks = 0;
					timer = ctx.setInterval(() => {
						// A real resize can deliver the in-band report a moment before the pty size,
						// so act only on a mismatch that outlasts one tick.
						staleTicks = terminalSizeStale(tui) ? staleTicks + 1 : 0;
						if (staleTicks >= 2) {
							staleTicks = 0;
							reconcileTerminalSize();
						}
						if (focusedSession(tui, ctx)?.id !== focused?.id) {
							// omp focused a subagent or returned to the main session: show that transcript.
							remount(ctx);
							return;
						}
						const synced = model.sync();
						if (model.setGlobalExpanded(ctx.ui.getToolsExpanded()) || synced) tui.requestRender();
					}, SYNC_MS);
					open = { model, live, close, requestRender: () => tui.requestRender() };
					if (!problem) {
						// Keys reach omp's editor as usual; this listener takes only the view's own.
						unsubscribe = ctx.ui.onTerminalInput(data => (view.route(data) ? { consume: true } : undefined));
						return view;
					}
					const readOnly: Component = {
						render: width => view.render(width),
						invalidate: () => view.invalidate(),
						handleInput: data => {
							if (!view.route(data) && matchesKey(data, "escape")) close();
						},
					};
					return readOnly;
				},
				{
					overlay: true,
					overlayOptions: {
						fullscreen: true,
						mouseTracking: true,
						anchor: "bottom-center",
						width: "100%",
						maxHeight: "100%",
						margin: 0,
					},
				},
			)
			.catch(error => ctx.ui.notify(`Fullscreen view failed: ${error}`, "error"))
			.finally(() => {
				mounting = false;
				unsubscribe?.();
				unfollow?.();
				if (timer !== undefined) ctx.clearTimer(timer);
				open?.model.dispose();
				open = undefined;
				const next = reopenWith;
				reopenWith = undefined;
				if (next) show(next);
			});
	}

	/** Close the open view and mount a fresh one for what `ctx` shows now. */
	function remount(ctx: ExtensionContext): void {
		if (!open) return;
		reopenWith = ctx;
		open.close();
		classic = false;
	}

	function onSessionChange(ctx: ExtensionContext): void {
		classic = false;
		main.streaming = undefined;
		main.tools.clear();
		// Input listeners and the session manager belong to the old session: remount.
		if (open) remount(ctx);
		else show(ctx);
	}

	pi.on("session_start", (_event, ctx) => onSessionChange(ctx));
	pi.on("session_switch", (_event, ctx) => onSessionChange(ctx));
	pi.on("session_shutdown", () => {
		reopenWith = undefined;
		open?.close();
	});

	/** Main-session events; the open view draws them only while it shows the main session. */
	const onMainEvent = (event: SessionEvent) => feed(main, event, open?.live === main ? open.model : undefined);
	pi.on("message_update", onMainEvent);
	pi.on("agent_end", onMainEvent);
	pi.on("tool_execution_start", onMainEvent);
	pi.on("tool_execution_update", onMainEvent);
	pi.on("tool_execution_end", onMainEvent);

	pi.registerShortcut(TOGGLE_KEY, {
		description: "Fullscreen transcript view",
		handler: ctx => {
			classic = false;
			show(ctx);
		},
	});

	pi.registerCommand("fullscreen", {
		description: "Toggle the fullscreen transcript view; `/fullscreen rail on|off` toggles the prompt rail",
		handler: async (args, ctx) => {
			const [sub, value] = args.trim().split(/\s+/);
			if (sub === "rail") {
				settings.rail = value === "on" ? true : value === "off" ? false : !settings.rail;
				saveSettings(settings);
				open?.requestRender();
				ctx.ui.notify(`Prompt rail ${settings.rail ? "on" : "off"}`, "info");
				return;
			}
			if (open) {
				open.close();
				return;
			}
			classic = false;
			show(ctx);
		},
	});
}

/** Record one session event in `live` and show it on `model` when that model draws the session. */
function feed(live: LiveState, event: SessionEvent, model: TranscriptModel | undefined): void {
	switch (event.type) {
		case "message_update":
			live.streaming = event.message;
			model?.setStreaming(live.streaming);
			return;
		case "agent_end":
			live.streaming = undefined;
			live.tools.clear();
			model?.setStreaming(undefined);
			return;
		case "tool_execution_start":
			live.tools.set(event.toolCallId, {});
			break;
		case "tool_execution_update": {
			const partial = toFrame(event.partialResult);
			if (!partial) return;
			live.tools.set(event.toolCallId, { partial });
			break;
		}
		case "tool_execution_end": {
			const result = toFrame(event.result);
			live.tools.set(event.toolCallId, result ? { final: { ...result, isError: event.isError } } : {});
			break;
		}
	}
	model?.refreshTool(event.toolCallId);
}

/** A tool result or progress frame from an execution event, or `undefined` when it has no content. */
function toFrame(value: unknown): ToolResultFrame | undefined {
	if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content)) return undefined;
	return { content: value.content, details: "details" in value ? value.details : undefined };
}
