# Memory store

Records every workspace's conversations, tool calls, and subagent runs into one
local SQLite memory database shared by all Sessions, then puts matched memories
back into the context before the model reads a step.

## Where to find it

Two entries, with the same content:

- **Settings → Memory store**: a full page.
- **Plugins → Memory store → below the description**: the same panel.

The panel is read-only browsing plus manual correction:

- Top stats: objects, occurrences, recorded turns, tool calls, queued messages.
- **Last injection** shows how many memories the previous injection carried, its
  token count, and which objects it named.
- Object list: name, kind, last action/state/detail, mention count, last date.
- **Merge…** folds one object into another and accumulates its occurrences. Every
  occurrence keeps its pointer, so nothing is lost.
- **Recent** is the timeline; the box filters objects by name.

## What it records

| Source | Stored |
|---|---|
| User input | distilled asynchronously into a memory card: object, kind, action, state, detail |
| Assistant reply | the final text summary per turn (streaming chunks are never stored) |
| Tool calls | tool name, static purpose, what the call did, time |
| Subagents | one row per run: parent, provider, outcome, duration, final answer summary |

It never stores a subagent's own transcript, and never stores your original
sentence — only a `(session, seq)` pointer that can take you back to it.

## Cost

- The first enable backfills history once (about 1.5 minutes for 100k events);
  later startups only process what is new.
- One small model request per turn, roughly ¥0.0008, capped at 60 per hour and
  configurable down or off.
- Injected memory is about 170–280 tokens against an 800-token budget.

## Turning it off

Disabling `normalize` stops distilling but keeps existing memories. Disabling
`injectMemories` stops injection only, so the model no longer sees memories.
Disabling the whole plugin stops recording; the database is kept and resumes
accumulating when you enable it again.
