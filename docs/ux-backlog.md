# UX backlog: closing the gap to Claude Code desktop

What OpenAgent still lacks, or does differently, compared with the Claude Code desktop app's day-to-day experience.
Ordered by how often a user would feel the difference. Items are ticked off as they land; each entry says where.

## Done in earlier rounds

Sessions sidebar (day groups, search, rename, fork, delete, generated titles) · transcript with tool rows, diffs,
thinking blocks, grouped reads · approval cards with keyboard answers and "allow for this session" · permission
modes incl. plan mode with plan cards · Browser, Diff and Terminal panes · image paste, queued messages, artifacts ·
MCP servers · context meter, auto-compaction and `/compact` · project instructions (OPENAGENT.md / AGENTS.md / CLAUDE.md).

## Backlog

| # | Gap | Why it matters | Status |
| --- | --- | --- | --- |
| 1 | **`@` file mentions** in the composer: typing `@` opens a fuzzy file picker over the working directory; the chosen file's contents go to the model with the message | The most used composer feature in Claude Code; today paths are typed or dropped by hand | done (tick 1) |
| 2 | **"Always allow … for this project"** on approval cards, persisted per working directory, with a Settings list to remove rules | Session-only allows mean re-approving `git`/`npm` every day | done (tick 1) |
| 3 | **System notifications** when a run finishes or waits for approval while the app is in the background (plus a Dock badge) | Long local-model runs are left alone; the desktop app tells you when to come back | done (tick 1) |
| 4 | **Rewind** to an earlier message: restore the files changed since then and reopen that prompt in the composer (Claude Code's checkpoints / `/rewind`) | The way out when a run went wrong | done (tick 2) |
| 5 | **Task list** maintained by the agent (a checklist card that updates in place while it works) | The desktop app pins the agent's plan under its latest message | done (tick 2) |
| 6 | **Message actions on hover**: copy a user message, re-send an edited one | Small, constant friction | done (tick 2) |
| 7 | **`#` memory shortcut**: a message starting with `#` appends to the project's instructions file after confirmation | Claude Code's quick way to teach the project | tick 3 |
| 8 | **Keyboard polish**: Esc Esc for rewind, ⌘↑/⌘↓ history in the composer, ⌘⇧C copy last reply | Power-user parity | tick 3 |
| 9 | **Welcome and empty states**: recent sessions and project hints on the empty screen, first-run checklist (Ollama running, model pulled, folder chosen) | First five minutes | tick 3 |
| 10 | **Transcript details**: collapse long tool output by default with "show more", sticky date dividers, unread marker when returning to a session | Reading long sessions | later |
| 11 | **Diff pane review**: accept/revert per hunk, "open in editor" per line | Reviewing larger changes | later |
| 12 | **Subagents / background tasks** with a Tasks pane | Parallel work; heavy for small local models | later |

Out of scope: hosted features (cloud sessions, remote control), Anthropic-specific fonts and branding, usage billing.

## How changes are verified

- `npm test` runs the headless suites in `test/` against the built app: a mock model server (OpenAI-compatible and Ollama-native) and a small stdio MCP server stand in for real services, so the agent loop, tools, approvals, compaction, mentions, rules, checkpoints and the terminal manager are exercised without a model.
- Live checks drive the running app over the Chrome DevTools Protocol (`electron . --remote-debugging-port=9222`) with the same mock server: they type into the composer, click cards and settings, and take screenshots; `window.__oc_debug` offers hooks to render synthetic states. These scripts live outside the repository for now.
- CPU is measured with per-process CPU-time deltas while a run streams (the spinner-only and streaming numbers in the commit history came from that).

## Tick 2 renderer spec (items 4–6)

Contract: `TaskItem`, the `tasks_updated` event, `SessionMeta.tasks`, `TranscriptItem.turn` and `SessionsApi.rewind` / `RewindResult` in `src/shared/types.ts`.

- **Hover actions on user bubbles** (`.msg.user`): a small action row that appears on hover (and on focus) at the bubble's top-right, like the Copy button on assistant replies: **Copy** (copies the typed text) and, when the item has a `turn`, **Rewind** (icon `rotate-ccw` or `history`). Live messages get their `turn` from the `sessions.current()` message count: the main process assigns one checkpoint per user message, so after a send the renderer can re-read the transcript (`sessions.switch(current.id)` after `run_end`) or keep a counter; simplest is to refresh the transcript items' `turn` values from `oc.sessions.switch(currentId)` once a run ends.
- **Rewind flow**: clicking Rewind opens the existing confirm dialog: title "Rewind to this message?", text "Files the agent wrote or edited after it go back to how they were, the later messages are removed, and the message returns to the composer. Changes made by commands are not undone." On OK call `oc.sessions.rewind(turn)`; re-render the transcript from `result.transcript`, put `result.text` into the composer (focus it, caret at the end), refresh the sessions list and the Diff pane, and add a system notice: "Rewound · N files restored" (plus "· M removed" and "· K could not be restored" when non-zero; "no files changed" when all are zero). Rewind is disabled while a run is in progress (the button is hidden then). Errors from the call show as an error notice.
- **Task list card** (`#task-list`): a card pinned under the transcript, above the status line and the queue, shown when the session has tasks (from `SessionMeta.tasks` on load/switch and from `tasks_updated` events; an empty list hides it). Header "Tasks" with "2 of 5 done" and a chevron to collapse (collapsed state remembered in localStorage); rows with a status glyph (pending: empty circle, in_progress: the app's spinner or a filled arrow, completed: check) and the title; the in-progress row is emphasised; completed rows are dimmed with a strike-through. It updates in place without flicker (keyed by id). Keep it compact: 13px rows, the card's own max height ~220px with scrolling.
- **Debug hooks**: `__oc_debug.tasks(tasks | null)` renders a list directly; `__oc_debug.user(text, images?, mentions?, turn?)` gains a `turn` argument so hover actions can be exercised without a run.
- Not in this tick: Esc Esc for rewind (item 8).
