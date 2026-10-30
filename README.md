<p align="center"><img src="build/icon.png" width="84" alt=""></p>
<h1 align="center">OpenAgent</h1>
<p align="center">Open-source Claude Code–style coding agent for macOS. Local models via Ollama, any provider via Portkey.</p>
<p align="center">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="macOS" src="https://img.shields.io/badge/macOS-Apple%20silicon-lightgrey.svg">
  <img alt="Electron" src="https://img.shields.io/badge/Electron-45-47848F.svg">
</p>
<p align="center"><img src="docs/screenshots/hero.png" width="820" alt="OpenAgent"></p>

## Why

- **Local first.** Runs on `qwen3:8b` through Ollama; nothing leaves your Mac. Built for small context windows: auto-compaction, a context meter.
- **The Claude Code workflow.** Permission modes, approval cards, plan mode, rewind, task list, queued messages, `@` file mentions, `#` memory.
- **See everything.** Tool rows with diffs, a Diff pane with revert, a real Terminal pane, a built-in browser the agent drives, artifacts beside the chat.
- **Standard extensions.** MCP servers (`.mcp.json`), skills (`SKILL.md`), project instructions (`OPENAGENT.md` / `AGENTS.md` / `CLAUDE.md`).
- **Small codebase.** Electron + TypeScript, no bundler, no framework.

## Quick start

```bash
brew install ollama && ollama serve &
ollama pull qwen3:8b
git clone https://github.com/BrandeisPatrick/openagent.git && cd openagent
npm install && npm start
```

Or download `OpenAgent.app` from [Releases](https://github.com/BrandeisPatrick/openagent/releases) (not notarized: right-click → Open the first time). Portkey: Settings → Provider → Portkey, add your key and a model id.

## Features

| | |
| --- | --- |
| <img src="docs/screenshots/approval.png" width="400"> | **Approvals.** Enter allows, `a` for the session, `p` for the project. Auto mode pauses only on risky actions. |
| <img src="docs/screenshots/mentions.png" width="400"> | **Composer.** `@` file picker, `/` skills, image paste, messages queued mid-run. |
| <img src="docs/screenshots/mcp.png" width="400"> | **MCP.** Paste a command, URL or README snippet; tools appear as `mcp__server__tool`. |
| <img src="docs/screenshots/rewind.png" width="400"> | **Rewind and tasks.** Restore files and reopen a prompt; the agent keeps a task list. |
| <img src="docs/screenshots/compaction.png" width="400"> | **Compaction.** Near the context limit the agent writes a brief and continues. |

Also: sessions with search and fork, plan mode, artifacts, skills, vision models, macOS notifications. Details, keys and tools: [docs/reference.md](docs/reference.md). Roadmap: [docs/ux-backlog.md](docs/ux-backlog.md).

## Develop

```bash
npm run typecheck   # both tsconfigs
npm test            # headless suites (mock model, no Ollama needed)
npm run package     # OpenAgent.app in release/mac-arm64
```

`src/main` is the agent and tools, `src/renderer` the UI, `src/shared` the IPC contract. MIT.
