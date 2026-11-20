# omp-fullscreen-view

A fullscreen transcript view for [omp](https://github.com/can1357/oh-my-pi) 19.0.0, written as an extension.

The view replaces the terminal's scrollback with a transcript you scroll inside omp. omp's own editor, status line and dialogs stay at the bottom of the screen and work as usual.

## Features

- Scroll with the mouse wheel, the scrollbar or the keyboard.
- Click a tool card, thinking block or summary to expand or collapse it.
- When you scroll up, a pill at the bottom counts new messages. Click it to jump back to the bottom.
- A sticky header shows the prompt above the top of the screen. Click it to jump to that prompt.
- A prompt rail on the right has one mark for each prompt. Hover over a mark to see the prompt and click it to jump there.
- Running tools show their output live, as in omp's normal view.
- When you focus a subagent (from the Agent Hub, a card click or double `←`), the view shows that subagent's transcript. When you return to the main session, it shows the main transcript again.
- `Ctrl+O` expands and collapses all blocks, as in omp's normal view.

## Install

Add the folder to `extensions` in `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/path/to/omp-fullscreen-view
```

Or link it:

```sh
omp install ./omp-fullscreen-view
```

omp loads extensions when it starts. Restart omp after you install or update the extension.

## Use

The view opens when an interactive session starts.

| Key or command | Action |
|---|---|
| `Alt+S` | Switch between the fullscreen view and omp's normal view |
| `/fullscreen` | Same as `Alt+S` |
| `/fullscreen rail on`, `off` | Show or hide the prompt rail. Without `on` or `off`, it switches. |
| `Page Up`, `Page Down` | Scroll half a screen |
| `Ctrl+Home` | Go to the start of the session |
| `Ctrl+End` | Go to the bottom and follow new output |

Other keys go to omp's editor as usual. The rail setting is saved in `settings.json` in the extension folder.

## Compatibility

The extension uses omp internals that are not a public API, so an omp update can break it. All of these dependencies are in `src/adapter.ts`. Before the view opens, it checks that omp still has what it needs. If a check fails, you get a warning and a read-only view without omp's editor. Press `Esc` to close that view.

It was tested with omp 19.0.0.

## Development

```sh
bun install
bun run check
```

`bun run check` type-checks the code against the published omp 19.0.0 type declarations.

## License

[MIT](LICENSE)
