/**
 * Swipe Pregeneration Extension for SillyTavern
 *
 * Feature 1: "Generate in Background" button next to the swipe-right chevron.
 *   Clicking it starts a swipe generation while the reader keeps seeing the 备选回复
 *   they chose, behind a 遮挡层. They can still move between finished 备选回复 while
 *   it runs, and the view stays wherever they left it.
 *
 * Feature 2: "Swipe pre-generation" entry in the Extensions wand menu.
 *   Opens a modal to batch-pre-generate N swipes with an optional progress bar.
 *
 * Feature 3: "Send and queue" button next to SillyTavern's send button.
 *   Sends the typed message and pre-generates extra swipes on top of the reply.
 *   The plain send button can be made to do the same from the settings panel.
 *
 * Feature 4: Settings panel in the Extensions drawer, most importantly the
 *   delay inserted between two queued generations.
 */

import {
    event_types,
    chat,
    isGenerating,
    saveChatConditional,
    addOneMessage,
    refreshSwipeButtons,
    saveSettingsDebounced,
} from '../../../../script.js';

import { getContext, extension_settings } from '../../../extensions.js';
import { SWIPE_DIRECTION, SWIPE_SOURCE } from '../../../constants.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { t } from '../../../i18n.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const MODULE_NAME   = 'swipe_pregen';
const PROGRESS_ID   = `${MODULE_NAME}_progress_bar`;
const SEND_BTN_ID   = `${MODULE_NAME}_send_queue_btn`;
const SETTINGS_ID   = `${MODULE_NAME}_settings`;
const BTN_CLASS     = 'sp_bg_gen_btn';

/**
 * The real messages, never the 遮挡层 clone standing in front of one. Callers take
 * `.last()` to get the last real message.
 *
 * Keyed on `mesid` rather than on `last_mes`: while a 遮挡层 is up the clone is
 * the last .mes in the chat, so SillyTavern hands it the `last_mes` class and a
 * lookup by that class would find nothing real to work with.
 */
const REAL_LAST_MES = '#chat .mes[mesid]';

/** How long to wait for a send to actually raise SillyTavern's generating flag. */
const GEN_START_TIMEOUT_MS = 10 * 1000;
/** Upper bound on how long to wait for the reply itself to finish. */
const GEN_END_TIMEOUT_MS   = 15 * 60 * 1000;

const DEFAULT_SETTINGS = {
    defaultBatchSize : 3,
    showProgressBar  : true,
    /** Pause between two queued generations, in milliseconds. */
    requestDelayMs   : 300,
    /** Total replies the send-and-queue button aims for (1 = a plain send). */
    sendBatchSize    : 3,
    /** Let SillyTavern's own send button queue swipes as well. */
    queueOnNormalSend: false,
};

// ─── State ────────────────────────────────────────────────────────────────────

let isBackgroundGenerating = false;  // single-gen lock
let batchAbort             = false;  // batch abort flag

/** Extra swipes armed by the send-and-queue button, consumed by GENERATION_STARTED. */
let armedExtraSwipes = 0;

/** True while a queue run is waiting for the reply it is going to extend. */
let queueWaiting = false;

/** Set when the user aborts or switches chat while a queue run is waiting. */
let queueCancelled = false;

/**
 * Live 遮挡层 state, or null when nothing is masked.
 *
 * `snapshotSwipeId` is the 备选回复 the clone was taken on and `bodyIsSnapshot`
 * whether it still holds that untouched copy of it - see `renderMask`.
 *
 * @type {{ real: HTMLElement, clone: HTMLElement, message: object, mesId: number,
 *          completedCount: number, viewedSwipeId: number,
 *          snapshotSwipeId: number, bodyIsSnapshot: boolean,
 *          handlers: { $el: JQuery, fn: Function }[] } | null}
 */
let mask = null;

// ─── Settings ─────────────────────────────────────────────────────────────────

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }

    // Backfill keys introduced by later versions into an existing settings object.
    const settings = extension_settings[MODULE_NAME];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) settings[key] = value;
    }

    return settings;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Parse a user-supplied number, clamped into range.
 * @returns {number} `fallback` when the input is not a number.
 */
function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    return isNaN(n) ? fallback : Math.min(Math.max(n, min), max);
}

/**
 * Poll `predicate` every 100 ms until it is true or `timeoutMs` has elapsed.
 * @returns {Promise<boolean>} the last value of the predicate.
 */
async function waitUntil(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(100);
    }
    return predicate();
}

/**
 * Retry `inject` until it reports success – several of the hosts we attach to
 * are built lazily by SillyTavern and are not in the DOM when we load.
 * @param {() => boolean} inject  Returns true once the injection succeeded.
 */
function pollUntilReady(inject, attempts = 20, intervalMs = 250) {
    if (inject() || attempts <= 0) return;
    setTimeout(() => pollUntilReady(inject, attempts - 1, intervalMs), intervalMs);
}

/**
 * True while a 排队 owns the screen, including the pauses between its
 * generations. `isBackgroundGenerating` only covers one generation, so on its
 * own it leaves the whole `requestDelayMs` gap open for a second run to start,
 * tear down the live 遮挡层 and expose the reply being written.
 */
function isRunActive() {
    return !!mask || isBackgroundGenerating;
}

/** Returns true when it is safe to start a background generation. */
function canStart() {
    if (isBackgroundGenerating) return false;
    if (isGenerating())         return false;

    const ctx = getContext();
    if (!ctx?.chat?.length) return false;

    const last = ctx.chat[ctx.chat.length - 1];
    return !!(last && !last.is_user && !last.is_system);
}

/**
 * Hide the message SillyTavern is about to write into, and show a copy of it in
 * its place, so the reader goes on seeing the 备选回复 they chose.
 *
 * The copy is a clone of the whole .mes with its `mesid` attribute stripped.
 * Every SillyTavern lookup that touches a message keys on `mesid` - streaming
 * (`#chat .mes[mesid="N"]`), addOneMessage, refreshSwipeButtons - so the clone
 * is invisible to all of them while inheriting the theme's styling for free.
 *
 * Nothing is reverted after the fact, which is the point: there is no frame in
 * which the incoming text can reach the screen.
 *
 * @param {{ mesId: number, message: object, completedCount: number, viewedSwipeId: number }} opts
 */
function applyMask({ mesId, message, completedCount, viewedSwipeId }) {
    removeMask();
    // Heal anything a previous run left behind before taking a fresh snapshot.
    document.querySelectorAll('#chat .sp_mask').forEach(el => el.remove());
    document.querySelectorAll('.sp_mask_hidden').forEach(el => el.classList.remove('sp_mask_hidden'));
    restoreLastMes();

    const real = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
    if (!real) return false;

    const clone = /** @type {HTMLElement} */ (real.cloneNode(true));
    // `mesid` is the only thing stripped: every SillyTavern lookup that writes to
    // a message keys on it. `last_mes` is deliberately kept, because the theme
    // hides the chevrons and the counter on anything that is not the last message.
    clone.removeAttribute('mesid');
    clone.classList.add('sp_mask');

    // The clone is the only copy that should answer to `last_mes` while masked.
    // SillyTavern's Escape handler targets '.last_mes .swipe_left' with no
    // :last, so leaving the class on the real element lets that gesture reach
    // SillyTavern's own handler and swipe the real message underneath us.
    real.classList.remove('last_mes');
    real.classList.add('sp_mask_hidden');
    real.after(clone);

    mask = {
        real, clone, message, mesId, completedCount, viewedSwipeId,
        // What the clone actually shows, which is whatever the real element was
        // displaying - not the 备选回复 the caller asks the mask to land on.
        snapshotSwipeId: message.swipe_id ?? 0,
        bodyIsSnapshot : true,
        handlers       : [],
    };

    // Bound through jQuery, not addEventListener. SillyTavern's own chevron
    // handler is delegated on `document`, and its keyboard shortcut, touch
    // gestures and Escape handler all reach it with `.trigger('click')`. jQuery
    // dispatches a triggered event through its own handler list - target first,
    // then ancestors - and only falls back to the native click at the very end.
    // A native listener therefore runs *after* the delegate and cannot stop it;
    // a jQuery handler on the element runs before it and can.
    for (const [selector, step] of [['.swipe_left', -1], ['.swipe_right', 1]]) {
        const $el = $(clone).find(selector);
        if (!$el.length) continue;
        const fn = (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            navigateMask(step);
        };
        $el.on('click', fn);
        mask.handlers.push({ $el, fn });
    }

    renderMask();
    return true;
}

/**
 * Hand `last_mes` back to the real last message.
 *
 * SillyTavern gives the class to whichever `.mes` comes last, which is the
 * 遮挡层 clone for as long as one is up, so it leaves with the clone.
 */
function restoreLastMes() {
    const messages = document.querySelectorAll(REAL_LAST_MES);
    messages.forEach(m => m.classList.remove('last_mes'));
    messages[messages.length - 1]?.classList.add('last_mes');
}

/** Fill the 遮挡层 with the 备选回复 the reader is currently on. */
function renderMask() {
    if (!mask) return;

    const { clone, completedCount } = mask;

    // Clamped here as well as in navigateMask: "4/3" was born of an out-of-range
    // swipe_id reaching a formatter, so the formatter itself refuses to print one.
    const id = Math.min(Math.max(mask.viewedSwipeId, 0), Math.max(0, completedCount - 1));

    // The clone is a copy of the finished message, so on the 备选回复 it was taken
    // from it already holds the real thing - including whatever a third-party
    // renderer built in there. Those renderers key on `mesid` and only re-scan a
    // message when SillyTavern names it in an event (酒馆助手 swaps an HTML
    // template's code block for an iframe that way), so none of them can rebuild
    // anything inside a mesid-less clone: re-filling this body from swipes[]
    // would drop the reader back to the bare source of their own template for the
    // whole run. Fill it only where the snapshot cannot answer, and from then on
    // always, because the snapshot is gone the first time it is overwritten.
    if (id !== mask.snapshotSwipeId || !mask.bodyIsSnapshot) {
        fillMaskBody(id);
        mask.bodyIsSnapshot = false;
    }

    // The slot being written is not a 备选回复, so it is neither counted nor reachable.
    const counter = clone.querySelector('.swipes-counter');
    if (counter) {
        // SillyTavern marks the counter hidden for the duration of a generation;
        // inside the 遮挡层 it is the reader's only position indicator.
        counter.removeAttribute('hidden');
        counter.textContent = `${id + 1}\u200b/\u200b${completedCount}`;
    }

    // The clone is a snapshot, so it never gains the classes SillyTavern adds to
    // the real message as the 排队 banks more 备选回复. `swipes_visible` is the one
    // that matters: without it the theme treats this message as having nothing to
    // swipe between and hides the chevrons and the counter.
    clone.classList.toggle('swipes_visible', completedCount > 1);

    clone.classList.toggle('sp_mask_at_start', id <= 0);
    clone.classList.toggle('sp_mask_at_end', id >= completedCount - 1);
}

/**
 * Write one 备选回复 into the 遮挡层's body: text, thinking, timer, token count.
 *
 * Only reached for a 备选回复 the clone's own snapshot cannot show - see renderMask.
 */
function fillMaskBody(id) {
    const { clone, message, mesId } = mask;
    const ctx = getContext();
    const info = message.swipe_info?.[id] ?? {};

    // Only message 0 is passed as -1. SillyTavern's formatter writes macro
    // substitutions back into chat[0].mes when handed message 0, which would
    // bake them into a stored greeting on every navigation step. Passing -1 for
    // every message would be worse: it leaves the regex engine's `depth`
    // undefined, and undefined does not mean depth 0 - it disables depth
    // filtering entirely, so depth-scoped user scripts would apply inside the
    // 遮挡层 and nowhere else, and the text would change as the mask came down.
    const fmtId = mesId === 0 ? -1 : mesId;

    // The -1 path also skips the macro substitution message 0 would normally
    // get, so an alternate greeting would show literal {{user}} / {{char}}.
    const raw = message.swipes?.[id] ?? message.mes ?? '';
    const body = mesId === 0 ? ctx.substituteParams(raw, undefined, message.name) : raw;

    const text = clone.querySelector('.mes_text');
    if (text) {
        text.innerHTML = ctx.messageFormatting(
            body, message.name, message.is_system, message.is_user, fmtId,
        );
    }

    // Without this the reader would see the old text paired with the incoming
    // reply's thinking, which reads as if the model contradicted itself.
    const details = clone.querySelector('.mes_reasoning_details');
    if (details) {
        const reasoning = info.extra?.reasoning ?? '';
        const reasoningBody = details.querySelector('.mes_reasoning');
        if (reasoning && reasoningBody) {
            reasoningBody.innerHTML = ctx.messageFormatting(
                reasoning, message.name, message.is_system, message.is_user, fmtId, {}, true,
            );
        }
        details.classList.toggle('sp_mask_empty', !reasoning);
    }

    // SillyTavern's own timer formatter is not exported; this is its value half.
    const timer = clone.querySelector('.mes_timer');
    if (timer) {
        const started = new Date(info.gen_started).getTime();
        const finished = new Date(info.gen_finished).getTime();
        const ok = !isNaN(started) && !isNaN(finished) && finished >= started;
        timer.textContent = ok ? `${((finished - started) / 1000).toFixed(1)}s` : '';
        timer.removeAttribute('title');
    }

    const tokens = clone.querySelector('.tokenCounterDisplay');
    if (tokens) {
        const count = info.extra?.token_count;
        tokens.textContent = count ? `${count}t` : '';
    }
}

/** Move the reader between finished 备选回复 while a generation is running. */
function navigateMask(step) {
    if (!mask) return;

    const next = mask.viewedSwipeId + step;
    if (next < 0 || next > mask.completedCount - 1) return;

    mask.viewedSwipeId = next;
    renderMask();
}

/** Drop the 遮挡层 and let the real message show again. */
function removeMask() {
    if (!mask) return;

    for (const { $el, fn } of mask.handlers) {
        $el.off('click', fn);
    }

    mask.clone.remove();
    mask.real.classList.remove('sp_mask_hidden');

    restoreLastMes();
    mask = null;
}

/**
 * Capture the minimal state needed to fully restore the viewed swipe.
 * @param {object} msg  - chat message object
 * @param {number} id   - swipe_id to save
 */
function captureState(msg, id) {
    const info = msg.swipe_info?.[id] ?? {};
    return {
        swipeId      : id,
        mes          : msg.mes,
        send_date    : msg.send_date,
        gen_started  : msg.gen_started,
        gen_finished : msg.gen_finished,
        extra        : JSON.parse(JSON.stringify(msg.extra ?? {})),
        swipe_info   : JSON.parse(JSON.stringify(info)),
    };
}

/**
 * Restore a chat message to a previously captured state.
 * Reads back from swipe_info if available (which has the canonical timestamps).
 *
 * @param {object} msg     - live chat message object (mutated in place)
 * @param {object} state   - previously returned by captureState()
 * @param {number} swipeId - the 备选回复 to land on; differs from the captured one
 *                           when the reader navigated while the 遮挡层 was up.
 */
function restoreState(msg, state, swipeId = state.swipeId) {
    msg.swipe_id = swipeId;

    // Prefer the data from swipe_info as it may have been updated during gen
    const liveInfo = msg.swipe_info?.[swipeId];
    if (liveInfo) {
        msg.mes          = msg.swipes[swipeId] ?? state.mes;
        msg.send_date    = liveInfo.send_date    ?? state.send_date;
        msg.gen_started  = liveInfo.gen_started  ?? state.gen_started;
        msg.gen_finished = liveInfo.gen_finished ?? state.gen_finished;
        msg.extra        = JSON.parse(JSON.stringify(liveInfo.extra ?? state.extra));
    } else {
        msg.mes          = state.mes;
        msg.send_date    = state.send_date;
        msg.gen_started  = state.gen_started;
        msg.gen_finished = state.gen_finished;
        msg.extra        = JSON.parse(JSON.stringify(state.extra));
    }
}

/**
 * Re-render a message after its viewed 备选回复 changed.
 *
 * MESSAGE_SWIPED is what SillyTavern emits after its own swipe re-render, and
 * third-party renderers are listening for it: 酒馆助手 keeps one iframe per
 * `mesid` and re-scans a message only when an event names it, so without the
 * emit the HTML template `addOneMessage` just rebuilt stays the bare source of
 * a code block. Every core listener already handles this event on every
 * ordinary swipe, which is exactly what this is.
 *
 * `refreshBgGenButton` has to come last: SillyTavern's re-render rebuilds the
 * swipe area, taking this extension's button with it.
 */
async function rerenderMessage(msg, mesId) {
    addOneMessage(msg, { type: 'swipe', forceId: mesId, showSwipes: true });
    refreshSwipeButtons(true);
    await getContext().eventSource.emit(event_types.MESSAGE_SWIPED, mesId);
    refreshBgGenButton();
}

// ─── Core: single background generation ──────────────────────────────────────

/**
 * Trigger a single swipe generation in the background.
 * The 备选回复 the reader is on stays on screen behind a 遮挡层.
 *
 * Awaits the entire swipe() call (including its internal endSwipe cleanup) so
 * we restore the view AFTER SillyTavern has finished all its house-keeping.
 * This avoids the spurious shake/red-flash that would happen if we restored
 * swipe_id before endSwipe() ran its "did the swipe succeed?" check.
 *
 * @param  {{ silent?: boolean }} [opts]  Pass `silent: true` to suppress the per-swipe success toast (used by batch mode).
 * @returns {Promise<boolean>} true if a new swipe was successfully generated.
 */
async function runBackgroundGeneration({ silent = false } = {}) {
    if (!canStart()) return false;

    const ctx       = getContext();
    const lastIdx   = ctx.chat.length - 1;
    const lastMsg   = ctx.chat[lastIdx];
    const origSwipe = lastMsg.swipe_id ?? 0;
    const origCount = lastMsg.swipes?.length ?? 1;

    // Ensure swipes array is initialised (mirrors what swipe() does internally)
    if (!Array.isArray(lastMsg.swipes)) {
        lastMsg.swipes     = [lastMsg.mes];
        lastMsg.swipe_id   = 0;
        lastMsg.swipe_info = [{
            send_date    : lastMsg.send_date,
            gen_started  : lastMsg.gen_started,
            gen_finished : lastMsg.gen_finished,
            extra        : JSON.parse(JSON.stringify(lastMsg.extra ?? {})),
        }];
    }

    // Snapshot the state we want to restore after generation finishes.
    const capturedState    = captureState(lastMsg, origSwipe);
    const chatId           = getContext()?.chatId;
    isBackgroundGenerating = true;

    // Spin first, mask second: the 遮挡层 is a clone, so it has to be taken after
    // the spinner class is on or the visible copy would show an idle button.
    const $lastMes = $(REAL_LAST_MES).last();
    $lastMes.find(`.${BTN_CLASS}`).addClass('sp_btn_spinning');

    // A 排队 holds one 遮挡层 across all of its generations, so that the reader's
    // view never blinks between them. Only put one up if nobody else owns it.
    // Ownership is the mask object itself, not a boolean. Between this run's
    // teardown and its `finally`, `mask` can be repopulated by another run - the
    // await on saveChatConditional below is long enough for a second click to
    // land - and a boolean would make this run tear down that run's live 遮挡层.
    const ownsMask = !mask;
    if (ownsMask) {
        applyMask({
            mesId          : lastIdx,
            message        : lastMsg,
            completedCount : origCount,
            viewedSwipeId  : origSwipe,
        });
    }
    const ownedMask = ownsMask ? mask : null;
    /** Take down only the 遮挡层 this call put up, and only if it is still ours. */
    const releaseMask = () => { if (ownedMask && mask === ownedMask) removeMask(); };

    try {
        // Await the full swipe including SillyTavern's endSwipe() cleanup.
        // The new content streams into the real message, which the 遮挡层 has
        // hidden; the reader is looking at the clone the whole time.
        // forceDuration:0 suppresses the slide-out / slide-in animation entirely.
        await ctx.swipe.to(null, SWIPE_DIRECTION.RIGHT, {
            source       : SWIPE_SOURCE.AUTO_SWIPE,
            forceSwipeId : lastMsg.swipes.length,   // force a new-generation slot
            forceDuration: 0,                        // no animation
        });
    } catch (err) {
        console.error('[SwipePregen] swipe.to failed:', err);
    } finally {
        $lastMes.find(`.${BTN_CLASS}`).removeClass('sp_btn_spinning');
        isBackgroundGenerating = false;
    }

    // Everything below is wrapped so that a throw can never leave the real
    // message hidden behind a 遮挡层 that nothing will take down again.
    try {
        // The reader may have walked away while this was generating; everything
        // below writes to chat state, which would land in the wrong conversation.
        if (getContext()?.chatId !== chatId) return false;

        // When a forced swipe is reverted, SillyTavern's endSwipe calls
        // redisplayChat, which removes the real message *and* the 遮挡层 clone
        // standing next to it. Re-anchor onto the freshly rendered element.
        if (mask && !mask.real.isConnected) {
            const { viewedSwipeId: viewed, completedCount: completed } = mask;
            removeMask();
            const reanchored = applyMask({ mesId: lastIdx, message: ctx.chat[lastIdx], completedCount: completed, viewedSwipeId: viewed });
            // Carrying on without a 遮挡层 would let the rest of the 排队 stream into
            // the message the reader is looking at, so stop the run instead.
            if (!reanchored) batchAbort = true;
        }

        // Check whether a new swipe slot was actually created.
        const updatedMsg = ctx.chat[lastIdx];
        const newCount   = updatedMsg?.swipes?.length ?? 0;

        // Read where the reader actually is before the 遮挡层 goes away - they may
        // have moved to another 备选回复 while this was running.
        const viewedSwipeId = mask?.viewedSwipeId ?? origSwipe;

        if (newCount > origCount) {
            // A new swipe was added.  Land on whatever the reader is looking at now,
            // not on wherever they were when this run started.
            restoreState(updatedMsg, capturedState, viewedSwipeId);

            if (ownedMask) {
                releaseMask();
            } else if (mask) {
                // One more 备选回复 is finished, so it becomes reachable and counted.
                mask.message        = updatedMsg;
                mask.completedCount = newCount;
                renderMask();
            }

            await rerenderMessage(updatedMsg, lastIdx);
            await saveChatConditional();
            if (!silent) toastr.success(t`Swipe ready! (${newCount} total)`, '', { timeOut: 2500 });
            return true;
        }

        // Nothing changed (generation cancelled / overswipe NONE / etc.) – clean up.
        releaseMask();
        refreshSwipeButtons(true);
        refreshBgGenButton();
        return false;
    } finally {
        releaseMask();
    }
}

// ─── Core: batch pre-generation ──────────────────────────────────────────────

/**
 * Pre-generate `count` swipes sequentially.
 * Displays a progress bar if the setting is enabled.
 *
 * @param {number} count  - Number of swipes to generate.
 */
async function runBatch(count) {
    if (isRunActive() || !canStart()) {
        toastr.warning(t`Cannot start pre-generation – generation already in progress.`);
        return;
    }

    batchAbort = false;
    const settings = getSettings();
    const ctx      = getContext();
    const mesId    = ctx.chat.length - 1;
    const message  = ctx.chat[mesId];
    const chatId   = ctx.chatId;

    if (settings.showProgressBar) showProgressBar(0, count);

    // One 遮挡层 for the whole 排队. Putting it up and taking it down around every
    // single generation would blink the reader's view on each pause, and would
    // tear the chevrons out from under them mid-click.
    applyMask({
        mesId,
        message,
        completedCount : message.swipes?.length ?? 1,
        viewedSwipeId  : message.swipe_id ?? 0,
    });

    let completed = 0;
    try {
        for (let i = 0; i < count; i++) {
            if (batchAbort) break;

            const ok = await runBackgroundGeneration({ silent: true });
            if (!ok) break;

            completed++;
            if (settings.showProgressBar) showProgressBar(completed, count);

            // Brief pause to avoid hammering the API
            if (i < count - 1 && !batchAbort) {
                await sleep(settings.requestDelayMs);
            }
        }
    } finally {
        const viewed = mask?.viewedSwipeId;
        removeMask();

        // The reader may have moved during the last generation, after the run
        // that would otherwise have committed their position.
        // `ctx.chat` is SillyTavern's live array, refilled in place on a chat
        // switch, so without this guard the commit below can land in whichever
        // conversation the reader moved to.
        const current = getContext()?.chatId === chatId ? ctx.chat[mesId] : null;
        if (typeof viewed === 'number' && current && current.swipe_id !== viewed
            && current.swipes?.[viewed] !== undefined) {
            restoreState(current, captureState(current, viewed), viewed);
            await rerenderMessage(current, mesId);
        }

        refreshBgGenButton();
        if (settings.showProgressBar) removeProgressBar();
    }

    if (completed > 0) {
        toastr.success(t`Pre-generation complete! Generated ${completed} swipe(s).`);
    }
}

// ─── Core: send and queue ────────────────────────────────────────────────────

/**
 * Wait for the generation that just started to land, then pre-generate `extra`
 * more swipes on top of the reply it produced.
 *
 * @param {number} extra  Number of additional swipes to queue.
 */
async function queueAfterCurrentGeneration(extra) {
    if (queueWaiting) return;
    queueWaiting   = true;
    queueCancelled = false;

    const chatId = getContext()?.chatId;

    try {
        // GENERATION_STARTED is emitted before SillyTavern raises its generating
        // flag, so wait for the flag to go up before waiting for it to drop.
        await waitUntil(() => queueCancelled || isGenerating(), GEN_START_TIMEOUT_MS);
        await waitUntil(() => queueCancelled || !isGenerating(), GEN_END_TIMEOUT_MS);
        if (queueCancelled) return;

        // Give SillyTavern a moment to render and save the fresh reply.
        await sleep(getSettings().requestDelayMs);
        if (queueCancelled || getContext()?.chatId !== chatId || !canStart()) return;

        await runBatch(extra);
    } finally {
        queueWaiting = false;
    }
}

/**
 * Send the typed message through SillyTavern's own send button, then queue the
 * remaining swipes on top of the reply.
 *
 * Clicking the real button keeps the whole send path intact (slash commands,
 * attachments, continue-on-send, group chats), so all we do is arm the counter
 * and let the GENERATION_STARTED handler pick it up.
 */
async function sendAndQueue() {
    if (isRunActive() || isGenerating()) {
        toastr.warning(t`A generation is already in progress.`);
        return;
    }

    armedExtraSwipes = Math.max(0, getSettings().sendBatchSize - 1);
    $('#send_but').trigger('click');

    // If the send was refused (no API connected, mid-swipe, …) nothing will ever
    // consume the arm, so drop it again.
    if (!await waitUntil(() => isGenerating(), GEN_START_TIMEOUT_MS)) {
        armedExtraSwipes = 0;
    }
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function showProgressBar(current, total) {
    let $bar = $(`#${PROGRESS_ID}`);
    if ($bar.length) {
        $bar.find('.sp_pb_current').text(current);
        $bar.find('.sp_pb_total').text(total);
        $bar.find('progress').val(current).attr('max', total);
        return;
    }

    $bar = $(`
        <div id="${PROGRESS_ID}" class="sp_progress_bar flex-container justifySpaceBetween alignItemsCenter">
            <div class="sp_pb_title">${t`Pre-generating swipes…`}</div>
            <div>(<span class="sp_pb_current">${current}</span>&thinsp;/&thinsp;<span class="sp_pb_total">${total}</span>)</div>
            <progress value="${current}" max="${total}" class="flex1"></progress>
            <button class="menu_button fa-solid fa-stop" title="${t`Stop pre-generation`}"></button>
        </div>
    `);

    $bar.find('button').on('click', () => {
        batchAbort = true;
        removeProgressBar();
    });

    // Insert before #chat inside the #sheld flex column so the bar sits
    // at the TOP of the chat area rather than below it.
    const $chatEl = $('#chat');
    if ($chatEl.length) {
        $chatEl.before($bar);
    } else {
        $('#sheld').prepend($bar);
    }
}

function removeProgressBar() {
    $(`#${PROGRESS_ID}`).remove();
}

// ─── Swipe-area button ────────────────────────────────────────────────────────

/**
 * (Re)inject the background-generate button into the swipeRightBlock of the
 * last message.  Safe to call multiple times – guards against duplicates.
 */
function refreshBgGenButton() {
    // Remove from any non-last message (happens after a new message arrives).
    const $lastMes = $(REAL_LAST_MES).last();

    // Strip the button from every message except the real last one and the
    // 遮挡层 clone. Keyed on identity rather than on `last_mes`, which belongs
    // to the clone while a run is masked.
    $(`#chat .mes .${BTN_CLASS}`).each(function () {
        const keep = ($lastMes.length && $lastMes[0].contains(this)) || this.closest('.sp_mask');
        if (!keep) this.remove();
    });

    if (!$lastMes.length) return;

    // Only show on non-user, non-system messages
    const ctx = getContext();
    if (!ctx?.chat?.length) return;
    const last = ctx.chat[ctx.chat.length - 1];
    if (!last || last.is_user || last.is_system) {
        $lastMes.find(`.${BTN_CLASS}`).remove();
        return;
    }

    if ($lastMes.find(`.${BTN_CLASS}`).length) return;  // already there

    const $btn = $(`<div class="${BTN_CLASS} fa-solid fa-forward" title="${t`Generate next swipe in background`}"></div>`);

    $btn.on('click', async (e) => {
        e.stopPropagation();
        if (isRunActive() || isGenerating()) {
            toastr.warning(t`A generation is already in progress.`);
            return;
        }
        await runBackgroundGeneration();
    });

    // Insert between the chevron and the swipes-counter for natural visual flow
    const $counter = $lastMes.find('.swipes-counter');
    if ($counter.length) {
        $counter.before($btn);
    } else {
        $lastMes.find('.swipeRightBlock').append($btn);
    }
}

// ─── Send-area button ─────────────────────────────────────────────────────────

/**
 * Inject the send-and-queue button next to SillyTavern's send button.
 * @returns {boolean} true once the button is in place.
 */
function addSendQueueButton() {
    if ($(`#${SEND_BTN_ID}`).length) return true;

    const $sendBut = $('#send_but');
    if (!$sendBut.length) return false;

    const $btn = $(`<div id="${SEND_BTN_ID}" class="fa-solid fa-layer-group interactable" tabindex="0" title="${t`Send and pre-generate extra swipes`}"></div>`);

    $btn.on('click', async (e) => {
        e.stopPropagation();
        await sendAndQueue();
    });

    // Left of the send button, so the send button keeps its usual position.
    $sendBut.before($btn);
    return true;
}

// ─── Settings panel ───────────────────────────────────────────────────────────

/**
 * Inject the settings drawer into the Extensions settings column.
 * @returns {boolean} true once the panel is in place.
 */
function addSettingsPanel() {
    if ($(`#${SETTINGS_ID}`).length) return true;

    const $host = $('#extensions_settings2');
    if (!$host.length) return false;

    const settings = getSettings();

    const $panel = $(`
        <div id="${SETTINGS_ID}" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${t`Swipe Pre-generation`}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="flex-container alignItemsCenter justifySpaceBetween">
                    <span>${t`Delay between requests (ms)`}</span>
                    <input id="sp_opt_delay" type="number" min="0" max="60000" step="100" class="text_pole" style="width:90px;">
                </label>
                <label class="flex-container alignItemsCenter justifySpaceBetween">
                    <span>${t`Replies per send`}</span>
                    <input id="sp_opt_send_size" type="number" min="1" max="20" class="text_pole" style="width:90px;">
                </label>
                <label class="checkbox_label">
                    <input id="sp_opt_queue_on_send" type="checkbox">
                    <span>${t`The normal send button queues replies too`}</span>
                </label>
                <label class="checkbox_label">
                    <input id="sp_opt_progress" type="checkbox">
                    <span>${t`Show progress bar`}</span>
                </label>
                <small class="sp_settings_hint">${t`The delay is applied between every two queued generations.`}</small>
            </div>
        </div>
    `);

    const $delay    = $panel.find('#sp_opt_delay').val(settings.requestDelayMs);
    const $sendSize = $panel.find('#sp_opt_send_size').val(settings.sendBatchSize);

    // Clamp on change rather than on input so typing is not fought mid-keystroke.
    $delay.on('change', function () {
        settings.requestDelayMs = clampInt($(this).val(), 0, 60000, DEFAULT_SETTINGS.requestDelayMs);
        $(this).val(settings.requestDelayMs);
        saveSettingsDebounced();
    });

    $sendSize.on('change', function () {
        settings.sendBatchSize = clampInt($(this).val(), 1, 20, DEFAULT_SETTINGS.sendBatchSize);
        $(this).val(settings.sendBatchSize);
        saveSettingsDebounced();
    });

    $panel.find('#sp_opt_queue_on_send').prop('checked', settings.queueOnNormalSend).on('change', function () {
        settings.queueOnNormalSend = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $panel.find('#sp_opt_progress').prop('checked', settings.showProgressBar).on('change', function () {
        settings.showProgressBar = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $host.append($panel);
    return true;
}

// ─── Extensions-menu entry ────────────────────────────────────────────────────

/**
 * Inject the wand-menu entry that opens the batch modal.
 * @returns {boolean} true once the entry is in place.
 */
function addExtensionsMenuEntry() {
    if ($('#sp_wand_entry').length) return true;  // guard against double-injection

    const $menu = $('#extensionsMenu');
    if (!$menu.length) return false;

    const $entry = $(`
        <div id="sp_wand_entry" class="extension_container">
            <div class="list-group-item flex-container flexGap5 alignItemsCenter"
                 id="sp_wand_btn"
                 title="${t`Swipe pre-generation`}"
                 style="cursor:pointer;">
                <i class="fa-solid fa-forward fa-fw"></i>
                <span data-i18n="Swipe pre-generation">Swipe pre-generation</span>
            </div>
        </div>
    `);

    $entry.find('#sp_wand_btn').on('click', async (e) => {
        e.stopPropagation();
        $('#extensionsMenu').hide();
        await openPregenModal();
    });

    $menu.append($entry);
    return true;
}

// ─── Pre-generation modal ─────────────────────────────────────────────────────

async function openPregenModal() {
    const settings = getSettings();

    // Build the modal content as a jQuery object.  We keep a reference so we
    // can read the input values AFTER callGenericPopup resolves – the DOM nodes
    // may already have been removed from the document by then, but jQuery still
    // lets us read detached nodes.
    const $content = $(`
        <div class="sp_modal_content">
            <h3 style="margin-top:0;">${t`Swipe Pre-generation`}</h3>
            <hr>
            <div class="flex-container alignItemsCenter" style="gap:12px; margin-bottom:12px;">
                <label for="sp_batch_size" style="white-space:nowrap;">
                    ${t`Number of swipes to pre-generate:`}
                </label>
                <input id="sp_batch_size"
                       type="number"
                       min="1"
                       max="20"
                       value="${settings.defaultBatchSize}"
                       class="text_pole"
                       style="width:70px;">
            </div>
            <div class="flex-container alignItemsCenter" style="gap:8px; margin-bottom:8px;">
                <input type="checkbox"
                       id="sp_show_progress"
                       ${settings.showProgressBar ? 'checked' : ''}>
                <label for="sp_show_progress">${t`Show progress bar`}</label>
            </div>
        </div>
    `);

    const result = await callGenericPopup($content[0], POPUP_TYPE.CONFIRM, null, {
        okButton    : t`Start`,
        cancelButton: t`Cancel`,
    });

    if (result === POPUP_RESULT.AFFIRMATIVE) {
        // Read values from our own cached jQuery reference – safe even if the
        // popup has already detached the nodes from the document.
        const count               = clampInt($content.find('#sp_batch_size').val(), 1, 20, settings.defaultBatchSize);
        settings.showProgressBar  = $content.find('#sp_show_progress').prop('checked');
        settings.defaultBatchSize = count;
        saveSettingsDebounced();
        runBatch(count);
    }
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

(function init() {
    const ctx = getContext();
    if (!ctx?.eventSource) {
        console.error('[SwipePregen] Could not get SillyTavern context.');
        return;
    }

    const { eventSource } = ctx;

    // Refresh the button whenever the message list changes
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => refreshBgGenButton());
    eventSource.on(event_types.USER_MESSAGE_RENDERED,      () => refreshBgGenButton());
    eventSource.on(event_types.MESSAGE_SWIPED,             () => refreshBgGenButton());
    eventSource.on(event_types.MESSAGE_DELETED,            () => refreshBgGenButton());
    eventSource.on(event_types.CHAT_LOADED,                () => refreshBgGenButton());

    // A plain user send is the cue to queue extra swipes on top of the reply.
    eventSource.on(event_types.GENERATION_STARTED, (type, _options, dryRun) => {
        if (dryRun || isBackgroundGenerating) return;
        if (type && type !== 'normal') return;  // swipe / continue / impersonate / quiet

        const settings   = getSettings();
        const armed      = armedExtraSwipes;
        armedExtraSwipes = 0;

        const extra = armed || (settings.queueOnNormalSend ? settings.sendBatchSize - 1 : 0);
        if (extra > 0) queueAfterCurrentGeneration(extra);
    });

    // Aborting the reply also cancels whatever was queued behind it.
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        armedExtraSwipes = 0;
        queueCancelled   = true;
    });

    // Clean up on chat switch
    eventSource.on(event_types.CHAT_CHANGED, () => {
        batchAbort       = true;
        armedExtraSwipes = 0;
        queueCancelled   = true;
        removeMask();
        removeProgressBar();
        isBackgroundGenerating = false;
    });

    // Several of these hosts are built lazily by SillyTavern, so poll for each.
    pollUntilReady(addExtensionsMenuEntry);
    pollUntilReady(addSendQueueButton);
    pollUntilReady(addSettingsPanel);

    // In case a chat is already loaded when this extension loads
    setTimeout(refreshBgGenButton, 500);

    console.log('[SwipePregen] Extension loaded.');
})();
