<p align="center">
  <img src="build/icon.png" width="96" alt="OpenAgent icon">
</p>

<h1 align="center">OpenAgent</h1>

<p align="center">
  An open-source, Claude Code–style coding agent for macOS.<br>
  Runs on your own models through Ollama, or on any provider through Portkey. One app, no subscription, your code stays on your Mac.
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="macOS" src="https://img.shields.io/badge/platform-macOS%20(Apple%20silicon)-lightgrey.svg">
  <img alt="Electron 45" src="https://img.shields.io/badge/Electron-45-47848F.svg">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-7-3178C6.svg">
</p>

<p align="center">
  <img src="docs/screenshots/hero.png" width="860" alt="OpenAgent: sessions sidebar, transcript, composer and the built-in browser pane">
</p>

Claude Code's desktop app is a great way to work with an agent: a transcript you can read, tool calls you can inspect, approvals you control, a browser and a terminal beside the chat. OpenAgent is that experience as an open-source app, built so that a local model such as `qwen3:8b` can do real work in it and a hosted model can do more.

## Why OpenAgent

- **Local first.** Point it at Ollama and everything, including the agent's reasoning, stays on your machine. Context compaction, a context meter and tool-less fallbacks are built for small context windows, not bolted on.
- **The Claude Code workflow, not a chat box.** Permission modes (ask, accept edits, auto with a safety guard, plan, bypass), approval cards with keyboard answers, "always allow for this project" rules, plan mode with plan cards, checkpoints you can rewind to, an agent-maintained task list, queued messages while a run is going.
- **Everything the agent touches is visible.** Tool rows with diffs and exit codes, a Diff pane with per-file revert, a real Terminal pane the agent and you share, a built-in browser the agent drives by visible text, artifacts rendered next to the chat.
- **Extensible the standard way.** MCP servers with Claude Code's `.mcp.json` format and `mcp__server__tool` naming, skills as `SKILL.md` folders, project instructions from `OPENAGENT.md`, `AGENTS.md` or `CLAUDE.md`.
- **Small and readable.** Electron plus TypeScript, no bundler, no framework: `src/main` is the agent and its tools, `src/renderer` is the UI. Read it in an afternoon, change it in an evening.

If this is the kind of tool you want to exist, a star helps other people find it.

## Quick start

```bash
# 1. a local model (or skip to Portkey below)
brew install ollama && ollama serve &
ollama pull qwen3:8b

# 2. the app
git clone https://github.com/BrandeisPatrick/openagent.git && cd openagent
npm install
npm start
```

Or skip the build: grab `OpenAgent.app` from the [latest release](https://github.com/BrandeisPatrick/openagent/releases). The build is not notarized yet, so the first time you open it, right-click the app and choose Open.

`npm run package` builds `release/mac-arm64/OpenAgent.app` yourself, which you can drag into Applications.

On first launch: pick your project folder from the title bar, type a task, press Enter. The agent reads and edits files, runs commands, browses the web and asks before anything with side effects. Use `@` to mention a file, `/` for skills and commands, Shift+Tab to change the permission mode.

**Portkey instead of Ollama.** Settings → Model provider → Portkey, paste your Portkey API key and a model id such as `@openai/gpt-4o-mini` or `@anthropic/claude-sonnet-4-5`. Any OpenAI-compatible endpoint works through the Ollama fields too (LM Studio, vLLM, llama.cpp, OpenRouter).

## What it does

| | |
| --- | --- |
| <img src="docs/screenshots/approval.png" width="420"> | **Approvals you control.** Commands, writes and edits show a card with the exact command or diff. Answer with Enter, `a` (this session) or `p` (always, for this project). Auto mode runs on its own but pauses on sudo, force pushes, deletes outside the project, published packages and the like. |
| <img src="docs/screenshots/mentions.png" width="420"> | **A composer like Claude Code's.** `@` opens a fuzzy file picker and sends the file with your message, `/` lists skills and commands, images paste in, messages typed during a run queue up for the agent's next step. |
| <img src="docs/screenshots/mcp.png" width="420"> | **MCP servers and tool rows.** Add a server by pasting its command line, URL or README snippet. Every call is one row: what it touched, the result, how long it took; images a tool returns show inline. |
| <img src="docs/screenshots/rewind.png" width="420"> | **Rewind and tasks.** Hover a message to rewind: files the agent changed after it are restored and the prompt comes back to edit. The agent keeps a task list that updates as it works. |
| <img src="docs/screenshots/compaction.png" width="420"> | **Built for small context windows.** When a conversation nears the model's window, the agent writes a handoff brief and continues from it; a divider shows where and what it kept. `/compact` does it on demand. |

More, in the order you will meet it:

- **Sessions** grouped by day with search, rename, fork and delete, generated titles, and a Dock badge plus a macOS notification when a run finishes or needs you while the app is in the background.
- **Panes.** Browser (back, forward, address bar, "open in browser"; the agent's clicks flash), Diff (every changed file, per-file revert, open in editor), Terminal (real shell tabs with zsh integration; the agent's `terminal_run` types into them like you would).
- **Plan mode.** The agent explores read-only, submits a plan as a card, and you choose "Build it", "Build, accept edits" or "Keep planning".
- **Artifacts.** HTML, SVG, Markdown and code deliverables open in the browser pane with Save as and Reveal in Finder.
- **Skills.** A folder with a `SKILL.md` becomes a `/command`; three are bundled (`/test`, `/review`, `/summarize-page`).
- **Vision.** With a vision model (`ollama pull qwen2.5vl:3b`) the agent sees pasted images; models without tool support still work as a plain chat.

## Permission modes

| Mode | Behaviour |
| --- | --- |
| Ask before actions | Commands, writes and edits show an approval card (default) |
| Accept edits | Edits inside the working directory run; commands still ask |
| Auto | Everything runs, except what the guard flags: sudo, destructive git, pushes, deletes or writes outside the project, piping downloads into a shell, publishing, cloud and macOS settings changes, secrets |
| Plan | Read-only exploration ending in a plan card you approve before anything is built |
| Bypass | Everything runs without asking |

"Allow … for this session" and "Always allow … for this project" on a card are specific: a command's program, a flagged reason, an MCP server, or edits in the project. Saved rules are listed in Settings → Permissions.

## Keyboard

`⌘N` new session · `⌘B` sidebar · `⌘⇧B` browser · `⌘⇧D` diff · `⌘⇧T` terminal · `⌘T` terminal tab · `⌘K` focus the composer (clears a focused terminal) · `⌘F` search sessions · `⌘,` settings · `F2` rename · `Esc` stop · `⇧Tab` cycle the permission mode · `⌘/` the shortcuts sheet. Slash commands: `/name` runs a skill, `/skills`, `/compact [focus]`, `/mcp`.

## Tools the agent has

| Tool | Purpose |
| --- | --- |
| `read_file`, `write_file`, `edit_file`, `list_directory`, `glob`, `grep` | Files |
| `bash` | A shell command in the working directory |
| `terminal_run`, `terminal_read`, `terminal_list`, `terminal_stop` | The Terminal pane's tabs, which you can watch and take over |
| `browser_navigate`, `browser_click`, `browser_type`, `browser_read_page`, `browser_find`, `browser_get_text`, `browser_wait_for`, `browser_screenshot`, `browser_press_key`, `browser_scroll`, `browser_eval` | The built-in browser, driven by visible text |
| `create_artifact` | An HTML, SVG, Markdown or code deliverable shown in the browser pane |
| `update_tasks` | The agent's task list card |
| `skill` | Load a skill by name |
| `submit_plan` | Plan mode: hand the plan to you |
| `mcp__<server>__<tool>` | Every tool of a connected MCP server |

## Configuration

Settings live in `~/Library/Application Support/OpenAgent/config.json` (sessions and artifacts next to it): provider, model, Ollama context size (`numCtx`, 16k by default; raise it for bigger models), permission mode, MCP servers, saved rules, notifications, auto-compact. A project's `.mcp.json` (Claude Code's format) is picked up automatically; its servers stay off until you enable them in Settings. Skills come from `<project>/.openagent/skills`, `~/.openagent/skills` and the bundled `skills/` folder.

## Project layout

```
src/main/      Electron main process: agent loop (agent.ts), tools/, providers, Ollama client,
               sessions and checkpoints, compaction, MCP (mcp.ts), terminal (node-pty), browser, artifacts
src/renderer/  The UI, plain TypeScript modules: transcript and tool rows, composer with mentions,
               panes (browser, diff, terminal), settings, context meter, task list
src/shared/    Types shared by both sides (the IPC contract)
skills/        Bundled skills · docs/ design notes and the UX backlog · scripts/ icon and packaging helpers
```

```bash
npm start            # build and run
npm run typecheck    # both tsconfigs
npm run package      # unsigned OpenAgent.app in release/mac-arm64
npm run icon         # regenerate the icon from build/icon.svg
```

Adding a tool: implement `Tool` in `src/main/tools/`, add it to `allTools()`, call `ctx.approve()` for anything with side effects. Adding a provider: any OpenAI-compatible endpoint works through the Ollama base URL; custom headers go in `src/main/providers.ts`.

## Security notes

The agent runs with your user's permissions: keep approvals on for untrusted tasks. Web pages it reads are untrusted input, and a local model may still follow instructions planted on a page. MCP servers run as child processes with your permissions; servers from a project's `.mcp.json` stay off until you enable them. `@` mentions send the named file to the model; only paths inside the working directory are expanded. Compaction sends the conversation to the model once more to write the brief. The built-in browser is a normal Chromium profile: do not sign in to sensitive accounts there while a run is active.

## Roadmap

What is still missing against the Claude Code desktop app, and the order it is being added in, is tracked in [docs/ux-backlog.md](docs/ux-backlog.md). Issues and pull requests are welcome; the test harness (headless mock-model suites and CDP-driven live checks) is described there too.

## License

MIT
