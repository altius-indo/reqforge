---
id: chat-and-changesets
title: Chat and changesets
tabs: changes, chat
keywords: claude, chat, ask, assistant, changeset, apply, reject, revise, stale, pending, choices, operations, mece, sync
---
Claude never edits records directly. It proposes a **changeset** — a batch of create, update and delete operations —
that you review and apply. Applying writes the whole batch atomically as one git commit.

### Ask Claude for a change

1. Click **Chat with Claude** in the header. The chat panel opens on the right; the dot next to *Claude* is green when
   the `claude` CLI is available on the server.
2. Leave **include view & selection** ticked to send your current tab, filters and selected rows as context.
3. Describe what you want — add, refine, merge or remove requirements — and press **Enter** (Shift+Enter adds a new
   line), or click **Send**.
4. When Claude asks a question with options, click an option button (or tick several and click **Send** for a
   multi-choice question).
5. Click **Stop** to interrupt a running turn, and **New** to start a fresh conversation.

Shortcuts: **Ask Claude about this view** on a list, **Ask Claude** in the record drawer or the bulk bar, and the
*Ask Claude…* buttons on the Lint, Traceability and Verification tabs prefill the chat with a ready-made prompt.

### Review and apply a changeset

1. A proposal appears as a changeset card in the chat. Read its verdicts: **valid**, **MECE holds**, the traceability
   result before → after, taxonomy gaps and lint errors before → after.
2. Read the operations. Untick an operation's checkbox to leave it out of the apply.
3. Check **Impact** for the stories, tasks, evals and components the change touches, and any listed risks.
4. Click **Apply** to write it (disabled while the changeset is invalid), **Ask to revise** to send feedback to
   Claude, or **Reject** to discard it.
5. After you apply, Claude follows up to verify the result.

### Find changesets later

1. Open the **Changes** tab. Its badge counts the pending changesets.
2. Click a row to open its changeset card and apply or reject it from there.
3. A changeset becomes **stale** when the records it touches were edited after it was proposed; ask Claude for a
   fresh one.
4. Click **Sync** in the header to commit, pull and push the project repository.
