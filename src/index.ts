import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type Component, matchesKey } from "@oh-my-pi/pi-tui";
import { chromeChildren, selfCheck, type ToolResultFrame } from "./adapter";
import { type LiveTool, TranscriptModel } from "./model";
import { loadSettings, saveSettings } from "./settings";
import { FullscreenView, TOGGLE_KEY } from "./view";

const SYNC_MS = 100;

interface StreamingMessage {
	role: string;
	timestamp: number;
}

export default function fullscreenView(pi: ExtensionAPI): void {
	const settings = loadSettings();
	/** The user left fullscreen with the toggle key; holds until the next session start or switch. */
	let classic = false;
	let streaming: StreamingMessage | undefined;
	/** Tool calls running in this session; the view draws their progress on the cards. */
	const liveTools = new Map<string, LiveTool>();
	let open: { model: TranscriptModel; close: () => void; requestRender: () => void } | undefined;
	let mounting = false;
	/** A session switch arrived while the old view was open: reopen once it has closed. */
	let reopenWith: ExtensionContext | undefined;

	function show(ctx: ExtensionContext): void {
		if (open || mounting || classic || ctx.mode !== "tui" || !ctx.hasUI || ctx.agent.kind !== "main") return;
		mounting = true;
		let unsubscribe: (() => void) | undefined;
		let timer: Timer | undefined;
		void ctx.ui
			.custom<void>(
				(tui, _theme, _keybindings, done) => {
					const problem = selfCheck(tui);
					if (problem) {
						ctx.ui.notify(`Fullscreen view: omp internals changed (${problem}); showing a read-only view`, "warning");
					}
					const model = new TranscriptModel(
						{
							ui: tui,
							cwd: ctx.cwd,
							settings: pi.pi.settings,
							requestRender: () => tui.requestRender(),
							getBranch: () => ctx.sessionManager.getBranch(),
							liveTools,
						},
						ctx.ui.getToolsExpanded(),
					);
					model.setStreaming(streaming);
					model.sync();
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
					timer = ctx.setInterval(() => {
						const synced = model.sync();
						if (model.setGlobalExpanded(ctx.ui.getToolsExpanded()) || synced) tui.requestRender();
					}, SYNC_MS);
					open = { model, close, requestRender: () => tui.requestRender() };
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
				if (timer !== undefined) ctx.clearTimer(timer);
				open?.model.dispose();
				open = undefined;
				const next = reopenWith;
				reopenWith = undefined;
				if (next) show(next);
			});
	}

	function onSessionChange(ctx: ExtensionContext): void {
		classic = false;
		streaming = undefined;
		liveTools.clear();
		if (open) {
			// Input listeners and the session manager belong to the old session: remount.
			reopenWith = ctx;
			open.close();
			classic = false;
		} else {
			show(ctx);
		}
	}

	pi.on("session_start", (_event, ctx) => onSessionChange(ctx));
	pi.on("session_switch", (_event, ctx) => onSessionChange(ctx));
	pi.on("session_shutdown", () => {
		reopenWith = undefined;
		open?.close();
	});

	pi.on("message_update", event => {
		streaming = event.message;
		open?.model.setStreaming(streaming);
	});
	pi.on("agent_end", () => {
		streaming = undefined;
		liveTools.clear();
		open?.model.setStreaming(undefined);
	});

	pi.on("tool_execution_start", event => {
		liveTools.set(event.toolCallId, {});
		open?.model.refreshTool(event.toolCallId);
	});
	pi.on("tool_execution_update", event => {
		const partial = toFrame(event.partialResult);
		if (!partial) return;
		liveTools.set(event.toolCallId, { partial });
		open?.model.refreshTool(event.toolCallId);
	});
	pi.on("tool_execution_end", event => {
		const result = toFrame(event.result);
		liveTools.set(event.toolCallId, result ? { final: { ...result, isError: event.isError } } : {});
		open?.model.refreshTool(event.toolCallId);
	});

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

/** A tool result or progress frame from an execution event, or `undefined` when it has no content. */
function toFrame(value: unknown): ToolResultFrame | undefined {
	if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content)) return undefined;
	return { content: value.content, details: "details" in value ? value.details : undefined };
}
