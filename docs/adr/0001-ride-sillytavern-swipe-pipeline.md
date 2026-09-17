# Ride SillyTavern's swipe pipeline and mask the message

预生成 runs through `Generate('swipe')` and hides the message being written behind a 遮挡层, rather than generating a 备选回复 headlessly. SillyTavern offers exactly one prompt shape that yields an *alternative* to the last reply — `type === 'swipe'`, the only type that drops the last message from the prompt (`coreChat.pop()`, script.js:4497) — and that path always writes into the live DOM. The 遮挡层 is therefore forced by SillyTavern's API shape, not a stylistic choice.

Line references are against SillyTavern release `06bde93` (2026-09-14) and will drift.

## Considered Options

**Headless generation via `generateQuietPrompt`.** It returns the text instead of writing it to the chat, which looks like exactly what we want. Rejected: `type === 'quiet'` is not in the `coreChat.pop()` branch, so the last reply stays in the prompt and the model answers it instead of replacing it. The output is the next turn, not a 备选回复.

**Native multi-candidate (`n > 1`).** SillyTavern can already ask a backend for several candidates in one request and stores them as 备选回复 itself (`canMultiSwipe`, openai.js:2788; `message.swipes.push(...)`, script.js:3776), and `'swipe'` is not excluded from it. One request, no 遮挡层, prompt billed once. Rejected as the foundation because coverage is partial — six chat-completion sources plus six text-completion types (`extractMultiSwipes`, script.js:6374); Claude, Gemini, OpenRouter, KoboldCpp, NovelAI and Horde are all outside it. Worth revisiting as a fast path, never as the only path.

**Redirecting the write at the data layer** — swapping the chat entry, generating into a scratch message. Rejected: the streaming target is resolved as `document.querySelector('#chat .mes[mesid="N"]')` (script.js:3596), keyed by index rather than by object, so no amount of data-level substitution stops it reaching the visible element.

**Reimplementing prompt construction.** Would buy a genuinely headless path. Rejected: it means duplicating world info, character cards, the prompt manager, instruct templates, group chats, extension injections, regex and reasoning parsing — and it breaks the plugin's core promise that the reader's own settings apply unchanged.
