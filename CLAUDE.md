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

**遮挡层 / mask** (`applyMask` / `renderMask` / `removeMask`) — the core trick, and the part most likely to be "simplified" into something broken. ST offers no way to generate an alternative to the last reply without writing it into that reply's live DOM (see `docs/adr/0001`), so the message the reader is looking at has to be hidden while it is written to.

`applyMask` clones the whole `.mes`, strips its `mesid`, hides the real element and puts the clone in its place. The ST paths that *render into* a message all resolve it by `mesid` — streaming (`#chat .mes[mesid="N"]`, script.js:3595), `addOneMessage`'s swipe branch, `updateSwipeCounter`, `refreshSwipeButtons` (which filters `.mes[mesid]`) — so the clone is invisible to them while inheriting the theme's styling for free.

That invisibility covers readers, not writers or enumerators: `updateViewMessageIds` (script.js:9470) *assigns* a `mesid` to any `.mes` it finds, `getFirstDisplayedMessageId` reads `Number(null) === 0` off the clone, and `chatElement.children('.mes').last()` in `deleteLastMessage` resolves to it. Those need a specific user action mid-run to matter — deleting the last message, deleting a message above it, or opening the swipe picker — but they do not widen the claim. `renderMask` then fills the clone from `swipes[]` / `swipe_info[]` for whichever 备选回复 the reader is on.

Five details are load-bearing and each was a bug before it was understood:
- The real element is hidden with `position: absolute; opacity: 0`, **never `display: none`**. ST animates the message's height while it is hidden (`thisMesDiv.css('height', …)` then `expandNewMessage`, script.js:10307). A `height` tween sends jQuery's `defaultPrefilter` into its box branch, which reads the element's `display`; when that reads `none` it runs a show/hide round-trip that writes `display: none` **inline** at animation *setup* — not on completion, so `duration: 0` does not save you. That inline value outlives the class and the message never comes back.
- The clone must be inserted *after* the real element, and the reason is `last_mes`, not layout. ST hides chevrons and counters on anything that is not the last message (`body:not(.swipeAllMessages) .mes:not(.last_mes) :is(.swipe_left, .swipe_right, .swipes-counter)`, style.css:1351) at a specificity that beats anything this stylesheet can write. A clone placed *before* the real element would leave `last_mes` on the real one and the clone's navigation would be dead on arrival.
- Being last means ST assigns `last_mes` to the clone (`chatElement.find('.mes').last()`, four sites). `removeMask` therefore has to hand the class back, and anything looking for the real last message must key on `mesid` (`REAL_LAST_MES`), not on `last_mes`. Note `:last-of-type` is per *tag name* among siblings, not per match: `#chat` carries trailing non-`.mes` div children during a run, so the selector resolves to one of those and matches nothing. Measured: 0 matches while masked, 3 with the plain form.
- Nothing is reverted after the fact. The previous implementation let ST write and then restored the old HTML on the next animation frame, which showed the incoming reply for a frame or more on every streamed chunk.
- Restoring the chevrons takes more than `opacity` and `pointer-events`. ST's hiding rule (the declaration is at style.css:1366, inside the rule whose `body.hideAllSwipeButtons` selector is at 1357) also sets `interactivity: inert`, which removes the element from hit-testing altogether — the chevron looks enabled, the cursor is a pointer, and the click lands on whatever is behind it. And because the clone is a snapshot it never gains `swipes_visible`, the class ST adds to the real message once it has more than one swipe (script.js:9298, and `refreshSwipeButtons` only walks `.mes[mesid]`). ST's own `.mes:not(.swipes_visible) .swipe_left` ties this stylesheet on specificity and loses on source order, so the class is not needed for *that* — it is needed for **this file's** `.last_mes.swipes_visible .sp_bg_gen_btn` rule. `renderMask` keeps it in sync. It does not sync `last_swipe`, which the same ST rule also reads; that is currently harmless only because `sp_mask_at_end` neutralises the right chevron at the end anyway, so treat `sp_mask_at_end` as load-bearing twice.
- The clone's body is left alone for the 备选回复 it was cloned on (`snapshotSwipeId`, and `bodyIsSnapshot` once navigation has overwritten it). The clone arrives holding the finished message *including whatever a third-party renderer built in there*, and those renderers cannot rebuild it: 酒馆助手 swaps a front-end card's code block for an iframe keyed on `mesid` and re-scans a message only when an ST event names it (`store/iframe_runtimes/message.ts`), so a `mesid`-less clone is invisible to it. Re-filling `.mes_text` from `swipes[]` therefore drops the reader back to the bare source of their own HTML template for the whole run — which is what `fillMaskBody` is for and why it runs only where the snapshot cannot answer. It still does for a 备选回复 the reader navigates to mid-run: nothing can render one of those inside the clone, so they see ST's own rendering — a code block for a front-end card — until the run ends.

A 排队 holds one mask for its whole run (`runBatch` owns it, `runBackgroundGeneration` only creates one when nobody else has). Putting a mask up and down around each generation blinks the reader's view on every pause and tears the chevrons out mid-click.

Because the mask spans the run but `isBackgroundGenerating` spans one generation, the two lifetimes diverge in every `requestDelayMs` pause — and in that gap `canStart()` reads as true. Entry points therefore gate on `isRunActive()` (mask *or* generation), not on `isBackgroundGenerating`; otherwise a second run starts inside the gap, `applyMask` tears down the live mask, and the reader watches the next reply being written.

**Swipe lifecycle** (`runBackgroundGeneration`) — ordering here is load-bearing:
- The view lands on `mask.viewedSwipeId`, read *before* the mask comes down, so a reader who navigated mid-run is not yanked back.
- `captureState()` snapshots `mes`, timestamps and `extra` for the currently viewed swipe before anything mutates.
- `ctx.swipe.to(null, RIGHT, { forceSwipeId: swipes.length, forceDuration: 0 })` forces a brand-new generation slot with animation suppressed.
- The `await` covers ST's internal `endSwipe()` cleanup. Restoring `swipe_id` before that finishes makes ST's "did the swipe succeed?" check fail and produces a shake/red-flash — do not restore early or drop the await.
- Success is detected by comparing `swipes.length` against the pre-generation count, not by the call resolving.
- `restoreState()` prefers live `swipe_info[id]` over the snapshot, since ST may have updated timestamps mid-generation.
- Restore concludes with `addOneMessage(..., { type: 'swipe', forceId, showSwipes: true })` → `refreshSwipeButtons(true)` → `MESSAGE_SWIPED` → `saveChatConditional()`. The emit is what ST itself does after its own swipe re-render (script.js:10315) and is not decoration: extensions that decorate a message hold one runtime per `mesid` and re-scan only when an event names it, so without it the HTML template `addOneMessage` has just rebuilt stays a bare code block for good. Every core listener (logprobs, memory, tts, translate, vectors) already takes this event on every ordinary swipe, which is exactly what a restore is.

**Batch mode** (`runBatch`) is a sequential loop over `runBackgroundGeneration({ silent: true })` — it reuses the exact single-swipe path, bails on the first failure or on `batchAbort`, and spaces calls by `requestDelayMs`. Count is clamped to 1–20. It owns the 遮挡层 for the whole run and commits the reader's final position in its `finally`.

**Navigation while generating** — ST blocks swiping whenever `isGenerating()` is true (`isSwipingAllowed`, script.js:9162) and hides the chevrons with `body.hideAllSwipeButtons`. The mask restores them on the clone and binds its own handlers. Navigation is clamped to finished 备选回复 — the slot being written is not one.

Those handlers must be bound **through jQuery**, not `addEventListener`. Restoring the chevrons re-opens gesture paths ST had deliberately closed, and ST reaches them with `.trigger('click')`. jQuery seeds its dispatch path with the target element and appends ancestors after it, exits the loop as soon as `isPropagationStopped()` is set, and only falls back to the native `click()` at the very end: a native listener therefore runs *after* ST's `document` delegate and cannot stop it, while a jQuery handler on the element runs before it. Worse, ST's `swipe()` resolves a `mesid`-less clone's click to `chat.length - 1` (script.js:9911) — the real message — so an unblocked gesture swipes for real underneath the mask.

Arrow keys and touch gestures use `$('.swipe_right:last')` (RossAscends-mods.js:1118, 1133, 925), which resolves to the clone, so the jQuery binding covers them. Escape uses `$('.last_mes .swipe_left')` with **no** `:last` (script.js:12347) and would hit every match — which is why `applyMask` takes `last_mes` off the real element, leaving the clone as the only answer to that selector. Without that, Escape is closed only by ST's own `swipeState` guard, which is not ours to rely on.

**Send and queue** (`sendAndQueue` → `queueAfterCurrentGeneration` → `runBatch`) rides on ST's own send path rather than reimplementing it: the button clicks the real `#send_but`, so slash commands, attachments, continue-on-send and group chats keep working. It only arms `armedExtraSwipes`, which the `GENERATION_STARTED` listener consumes. That listener is also where the "normal send queues too" setting is applied, and it filters on the emitted `type` so only plain sends (`'normal'`) qualify — swipes, continues, impersonations and quiet prompts do not, which is what keeps our own batch swipes from re-arming the queue.

Two ordering facts drive `queueAfterCurrentGeneration`:
- ST emits `GENERATION_STARTED` *before* it sets `is_send_press`, so the function waits for `isGenerating()` to go up before waiting for it to come back down. Skipping the first wait makes it think the reply already landed.
- `GENERATION_STOPPED` and `CHAT_CHANGED` set `queueCancelled`, and the chat id is re-checked before `runBatch`, so an aborted or abandoned reply never gets swipes queued onto it.

**Button injection** (`refreshBgGenButton`) is idempotent and re-run on ST events (`CHARACTER_MESSAGE_RENDERED`, `USER_MESSAGE_RENDERED`, `MESSAGE_SWIPED`, `MESSAGE_DELETED`, `CHAT_LOADED`); `CHAT_CHANGED` tears down state, the 遮挡层 and the progress bar. Visibility is *not* controlled by JS — `style.css` keys off ST's own classes (`.last_mes.swipes_visible`, `.last_swipe`, `body[data-generating]`, `body.hideAllSwipeButtons`). The `.sp_btn_spinning` rules deliberately carry higher specificity so the spinner survives ST's generation-time hiding; changing those selectors will make the button vanish mid-generation.

**UI injection** — `addExtensionsMenuEntry`, `addSendQueueButton` and `addSettingsPanel` each return a readiness boolean and are driven by `pollUntilReady` (20 tries, 250ms), because ST builds several of these hosts lazily.

The send-area button deliberately carries no colour or size of its own: `style.css` lets it inherit from `#rightSendForm` so it matches `#send_but` under every theme, and a `:has(> #send_but.displayNone)` rule plus the `body[data-generating]` / `[data-swiping]` selectors keep the two buttons appearing and disappearing together.

New settings keys must be added to `DEFAULT_SETTINGS`; `getSettings()` backfills them into an existing stored object, so users upgrading do not get `undefined` where a number is expected.

**Modal** (`openPregenModal`) keeps its own jQuery reference to the content node and reads input values from it after `callGenericPopup` resolves — the nodes are detached by then, so querying the document would return nothing.

## i18n

User-facing strings go through the `` t`...` `` tag from ST's `i18n.js`. The literal English string *is* the lookup key; interpolations become `${0}`, `${1}` in the key (see `"Swipe ready! (${0} total)"`). `i18n/en.json` is the reference; a new or reworded string means adding the key to all of `en`, `de`, `zh-CN`, `fr`, and rewording an existing string changes its key in every file.
