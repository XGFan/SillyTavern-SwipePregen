/**
 * Swipe Pregeneration Extension for SillyTavern
 *
 * Feature 1: "Generate in Background" button next to the swipe-right chevron.
 *   Clicking it starts a swipe generation while keeping the current message readable
 *   via a visual overlay. When generation completes, the view automatically snaps
 *   back to the original swipe so the user can swipe right at their own pace.
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

/** Direct reference to the frozen real .mes element, for height-lock cleanup. */
let $frozenMes = null;

/** Original inline styles we temporarily override during the freeze. */
let frozenStyles = null;

/** MutationObserver that keeps .mes_text showing the frozen HTML during streaming. */
let _frozenObserver = null;

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
 * Freeze the last message by (a) locking the .mes container height so it can't
 * grow or shrink, and (b) using a MutationObserver to instantly restore the
 * original rendered HTML whenever SillyTavern's streaming overwrites .mes_text.
 *
 * This keeps the real element in place in the normal document flow so the user
 * can scroll freely and reads the original message throughout generation.
 *
 * @param {jQuery} $lastMes  - The .mes element (last_mes)
 */
function createFreezeOverlay($lastMes) {
    const $mesText = $lastMes.find('.mes_text').first();
    if (!$mesText.length) return;

    const mesTextEl  = $mesText[0];
    const frozenHtml = mesTextEl.innerHTML;  // snapshot of fully-rendered content

    // Lock the message container at its current height so neither the streaming
    // placeholder "..." nor an eventually longer generated message resizes it.
    frozenStyles = {
        mesHeight    : $lastMes[0].style.height,
        mesMinHeight : $lastMes[0].style.minHeight,
        mesOverflow  : $lastMes[0].style.overflow,
    };
    $lastMes.css({
        height    : $lastMes.outerHeight(),
        minHeight : $lastMes.outerHeight(),
        overflow  : 'hidden',
    });

    // Watch .mes_text for any change and immediately restore the frozen HTML.
    // Disconnect → mutate → reconnect prevents infinite recursion.
    // requestAnimationFrame batches rapid streaming updates to ≤1 restore/frame.
    let rafPending = false;
    _frozenObserver = new MutationObserver(() => {
        if (rafPending || !_frozenObserver) return;
        rafPending = true;
        requestAnimationFrame(() => {
            if (!_frozenObserver) { rafPending = false; return; }
            _frozenObserver.disconnect();
            mesTextEl.innerHTML = frozenHtml;
            _frozenObserver.observe(mesTextEl, { childList: true, subtree: true, characterData: true });
            rafPending = false;
        });
    });
    _frozenObserver.observe(mesTextEl, { childList: true, subtree: true, characterData: true });

    $frozenMes = $lastMes;
}

/** Stop the freeze observer and restore all temporarily-overridden styles. */
function removeOverlay() {
    if (_frozenObserver) {
        _frozenObserver.disconnect();
        _frozenObserver = null;
    }

    if ($frozenMes && frozenStyles) {
        $frozenMes.css({
            height    : frozenStyles.mesHeight,
            minHeight : frozenStyles.mesMinHeight,
            overflow  : frozenStyles.mesOverflow,
        });
    }

    $frozenMes   = null;
    frozenStyles = null;
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
 * @param {object} msg   - live chat message object (mutated in place)
 * @param {object} state - previously returned by captureState()
 */
function restoreState(msg, state) {
    msg.swipe_id = state.swipeId;

    // Prefer the data from swipe_info as it may have been updated during gen
    const liveInfo = msg.swipe_info?.[state.swipeId];
    if (liveInfo) {
        msg.mes          = msg.swipes[state.swipeId] ?? state.mes;
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

// ─── Core: single background generation ──────────────────────────────────────

/**
 * Trigger a single swipe generation in the background.
 * The current swipe remains readable via a freeze overlay.
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
    isBackgroundGenerating = true;

    // Build the freeze overlay before triggering generation so the user can
    // keep reading the current message while the new one streams underneath.
    const $lastMes  = $('#chat .last_mes');
    createFreezeOverlay($lastMes);

    // Keep the original button visible as the activity indicator.
    $lastMes.find(`.${BTN_CLASS}`).addClass('sp_btn_spinning');

    try {
        // Await the full swipe including SillyTavern's endSwipe() cleanup.
        // The new content streams into the hidden .mes_text; the MutationObserver
        // instantly restores the frozen HTML so the user reads the original message.
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

    // Check whether a new swipe slot was actually created.
    const updatedMsg = ctx.chat[lastIdx];
    const newCount   = updatedMsg?.swipes?.length ?? 0;

    if (newCount > origCount) {
        // A new swipe was added.  Snap the view back to what the user was
        // reading (new swipe is accessible by swiping right).
        restoreState(updatedMsg, capturedState);
        // Stop the observer before re-rendering so addOneMessage can freely
        // update .mes_text with the original swipe content.
        removeOverlay();
        addOneMessage(updatedMsg, { type: 'swipe', forceId: lastIdx, showSwipes: true });
        refreshSwipeButtons(true);
        await saveChatConditional();
        if (!silent) toastr.success(t`Swipe ready! (${newCount} total)`, '', { timeOut: 2500 });
        return true;
    }

    // Nothing changed (generation cancelled / overswipe NONE / etc.) – clean up.
    removeOverlay();
    refreshSwipeButtons(true);
    return false;
}

// ─── Core: batch pre-generation ──────────────────────────────────────────────

/**
 * Pre-generate `count` swipes sequentially.
 * Displays a progress bar if the setting is enabled.
 *
 * @param {number} count  - Number of swipes to generate.
 */
async function runBatch(count) {
    if (!canStart()) {
        toastr.warning(t`Cannot start pre-generation – generation already in progress.`);
        return;
    }

    batchAbort = false;
    const settings = getSettings();

    if (settings.showProgressBar) showProgressBar(0, count);

    let completed = 0;
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

    if (settings.showProgressBar) removeProgressBar();

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
    if (isBackgroundGenerating || isGenerating()) {
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
    // Remove from any non-last message (happens after a new message arrives)
    $(`#chat .mes:not(.last_mes) .${BTN_CLASS}`).remove();

    const $lastMes = $('#chat .last_mes');
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
        if (isBackgroundGenerating || isGenerating()) {
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
        removeOverlay();
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
