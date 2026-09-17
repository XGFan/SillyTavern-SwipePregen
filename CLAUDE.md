# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A third-party SillyTavern extension that pre-generates swipes for the last AI message. Entry points: a background-generate button in the last message's swipe area, a batch modal in the Extensions wand menu, a send-and-queue button next to SillyTavern's send button, and a settings drawer in the Extensions panel.

## Build / test / run

There is none. No `package.json`, no bundler, no test runner, no lint config — `index.js` and `style.css` are loaded verbatim by SillyTavern per `manifest.json`.

Consequences:
- The only way to exercise a change is a running SillyTavern with this directory at `SillyTavern/public/scripts/extensions/third-party/SillyTavern-SwipePregen/`, then reloading the page (no ST restart needed for JS/CSS edits).
- Debugging happens in the browser devtools console; logs are prefixed `[SwipePregen]`.
- Bump `version` in `manifest.json` for user-visible changes — `auto_update` is on, so that field is what triggers updates for installed users.

## Host-environment constraints

- Imports use fixed relative depth (`../../../../script.js`, `../../../extensions.js`). They only resolve at the install path above. Never move `index.js` into a subdirectory or add a nesting level.
- `$` (jQuery) and `toastr` are ST globals — used un-imported on purpose; don't add imports for them.
- Everything imported comes from ST internals (`script.js`, `extensions.js`, `constants.js`, `popup.js`, `i18n.js`). These are not versioned APIs; when a symbol behaves unexpectedly, check the installed ST source rather than assuming a bug here.

## Architecture

`index.js` is one module organized in commented sections, with two globals of shared state: `isBackgroundGenerating` (single-gen lock) and `batchAbort`.

**Freeze mechanism** (`createFreezeOverlay` / `removeOverlay`) — the core trick. There is no overlay element. The real `.mes` stays in document flow so the user can scroll and read normally, while ST streams the new swipe into the same `.mes_text`. Two parts hold the illusion:
1. The `.mes` container's height/minHeight/overflow are locked to the pre-generation size (originals saved in `frozenStyles` for restore).
2. A `MutationObserver` rewrites `.mes_text.innerHTML` back to the snapshot on every streaming write. It must disconnect → mutate → reconnect or it re-triggers itself, and it batches through `requestAnimationFrame` to at most one restore per frame.

`removeOverlay()` must run *before* `addOneMessage()` re-renders, otherwise the observer reverts the newly rendered swipe.

**Swipe lifecycle** (`runBackgroundGeneration`) — ordering here is load-bearing:
- `captureState()` snapshots `mes`, timestamps and `extra` for the currently viewed swipe before anything mutates.
- `ctx.swipe.to(null, RIGHT, { forceSwipeId: swipes.length, forceDuration: 0 })` forces a brand-new generation slot with animation suppressed.
- The `await` covers ST's internal `endSwipe()` cleanup. Restoring `swipe_id` before that finishes makes ST's "did the swipe succeed?" check fail and produces a shake/red-flash — do not restore early or drop the await.
- Success is detected by comparing `swipes.length` against the pre-generation count, not by the call resolving.
- `restoreState()` prefers live `swipe_info[id]` over the snapshot, since ST may have updated timestamps mid-generation.
- Restore concludes with `addOneMessage(..., { type: 'swipe', forceId, showSwipes: true })` → `refreshSwipeButtons(true)` → `saveChatConditional()`.

**Batch mode** (`runBatch`) is a sequential loop over `runBackgroundGeneration({ silent: true })` — it reuses the exact single-swipe path, bails on the first failure or on `batchAbort`, and spaces calls by `requestDelayMs`. Count is clamped to 1–20.

**Send and queue** (`sendAndQueue` → `queueAfterCurrentGeneration` → `runBatch`) rides on ST's own send path rather than reimplementing it: the button clicks the real `#send_but`, so slash commands, attachments, continue-on-send and group chats keep working. It only arms `armedExtraSwipes`, which the `GENERATION_STARTED` listener consumes. That listener is also where the "normal send queues too" setting is applied, and it filters on the emitted `type` so only plain sends (`'normal'`) qualify — swipes, continues, impersonations and quiet prompts do not, which is what keeps our own batch swipes from re-arming the queue.

Two ordering facts drive `queueAfterCurrentGeneration`:
- ST emits `GENERATION_STARTED` *before* it sets `is_send_press`, so the function waits for `isGenerating()` to go up before waiting for it to come back down. Skipping the first wait makes it think the reply already landed.
- `GENERATION_STOPPED` and `CHAT_CHANGED` set `queueCancelled`, and the chat id is re-checked before `runBatch`, so an aborted or abandoned reply never gets swipes queued onto it.

**Button injection** (`refreshBgGenButton`) is idempotent and re-run on ST events (`CHARACTER_MESSAGE_RENDERED`, `USER_MESSAGE_RENDERED`, `MESSAGE_SWIPED`, `MESSAGE_DELETED`, `CHAT_LOADED`); `CHAT_CHANGED` tears down state, overlay and progress bar. Visibility is *not* controlled by JS — `style.css` keys off ST's own classes (`.last_mes.swipes_visible`, `.last_swipe`, `body[data-generating]`, `body.hideAllSwipeButtons`). The `.sp_btn_spinning` rules deliberately carry higher specificity so the spinner survives ST's generation-time hiding; changing those selectors will make the button vanish mid-generation.

**UI injection** — `addExtensionsMenuEntry`, `addSendQueueButton` and `addSettingsPanel` each return a readiness boolean and are driven by `pollUntilReady` (20 tries, 250ms), because ST builds several of these hosts lazily.

The send-area button deliberately carries no colour or size of its own: `style.css` lets it inherit from `#rightSendForm` so it matches `#send_but` under every theme, and a `:has(> #send_but.displayNone)` rule plus the `body[data-generating]` / `[data-swiping]` selectors keep the two buttons appearing and disappearing together.

New settings keys must be added to `DEFAULT_SETTINGS`; `getSettings()` backfills them into an existing stored object, so users upgrading do not get `undefined` where a number is expected.

**Modal** (`openPregenModal`) keeps its own jQuery reference to the content node and reads input values from it after `callGenericPopup` resolves — the nodes are detached by then, so querying the document would return nothing.

## i18n

User-facing strings go through the `` t`...` `` tag from ST's `i18n.js`. The literal English string *is* the lookup key; interpolations become `${0}`, `${1}` in the key (see `"Swipe ready! (${0} total)"`). `i18n/en.json` is the reference; a new or reworded string means adding the key to all of `en`, `de`, `zh-CN`, `fr`, and rewording an existing string changes its key in every file.
