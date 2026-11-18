# Pulse OS v6: speed + assistant upgrade (based on HEAD d9b2cb1)

These files are not pushed anywhere. To apply them, copy each one over the repo path of the same name.
`withPulseNativeOS.js` is untouched, `app.json` has no reference to it, and `pulseFeatures.ts` is unchanged.

## Files

### Root
| Path | Summary |
| --- | --- |
| `App.tsx` | Rewritten shell and chat. Default model is flash-lite. Streaming is throttled, chats are saved with a debounce and without base64 data, and history is built correctly. Adds web search with source chips, action buttons, reminder cards, memory, attachments, a mic button and the 🔊 toggle (off by default). Settings gains Memory, Reminders and in-app Update with a progress bar. The Apps tab opens apps through intents. All PulseBridge and accessibility code is removed. |
| `ComputerScreen.tsx` | Live MJPEG stream in a WebView `<img>`. Tap sends normalized click coordinates and swipe scrolls the page. State comes from SSE read over XHR streaming, with backoff and reconnect. Adds a Wake button and unmounts the stream when the tab is hidden. Falls back to the old `/screen.jpg` and `/state` polling on older servers. |
| `HandsFreeScreen.tsx` | **New.** A voice loop: listen with expo-speech-recognition, send automatically when speech ends, stream the reply, speak it sentence by sentence, then listen again. Includes barge-in, a big Stop button, permission and error messages, a listening indicator, and spoken yes/no to confirm reminders. |
| `app.json` | Version 6.0.0. Plugins added: `expo-image-picker` (camera and photos permission strings) and `expo-speech-recognition` (mic strings plus Google speech-service package queries). Permissions added: `SCHEDULE_EXACT_ALARM`, `USE_EXACT_ALARM` and `RECEIVE_BOOT_COMPLETED`; `REQUEST_INSTALL_PACKAGES` is kept. The overlay permission `SYSTEM_ALERT_WINDOW` is removed and added to `blockedPermissions`, and `FOREGROUND_SERVICE_SPECIAL_USE` is removed. There is no expo-notifications plugin and no withPulseNativeOS plugin. |
| `package.json` | Version 6.0.0, with the new dependencies listed below. |

### server/
| Path | Summary |
| --- | --- |
| `server/computer.js` | Adds `GET /stream` (MJPEG pushed by CDP screencast only when the page repaints, plus a keep-alive frame every 1.5 s, max about 11 fps, viewport 412x860, JPEG quality 55, backpressure drops stale frames). Adds `GET /events` (SSE) and `POST /wake`. Keeps one page and follows popup tabs (max 3). The agent loop now uses `domcontentloaded` with a 250 ms settle, sends screenshots only on step 1, after errors, on sparse pages or when the model asks with `look`, and otherwise sends a compact element list plus page text. Agent models run flash-lite-latest → flash-latest → 3.5-flash-lite → 3.5-flash; 1.x, 2.x and pro models are blocked. Thinking is set to minimal or low. Stop aborts the running Gemini call. Safety is stricter: no typing into password, OTP, PIN, UPI PIN or card fields, and the agent asks before pay, order, book, send, post or delete, including pressing Enter on a message box. All legacy endpoints are kept. Wake-up no longer blocks on the home page, and a navigation race is fixed. |
| `server/server.js` | Accepts the token as `?token=` as well as a Bearer header. The default chat model is flash-lite-latest with the same fallback chain and banned models. Uses `thinkingLevel` instead of the 2.5-only `thinkingBudget`. The system prompt is now short and concierge-style. `/health` reports `computer_features` and `agent_models`. Version 3.0.0. There are still no shell endpoints, and PULSE_TOKEN is still required for /api/computer. |

### Other (new `src/` modules)
| Path | Summary |
| --- | --- |
| `src/gemini.ts` | SSE streaming client. Runs a model chain with minimal or low thinking, retries without thinking or tools if a model rejects them, uses the `google_search` tool with grounding sources, supports abort, and includes a JSON helper and the time-sensitive / factual-question heuristic. |
| `src/assistant.ts` | Concierge system prompt with the current IST time, profile, memory, notes and an ACTIONS protocol. Builds history in order, with roles strictly alternating user/model, starting and ending with the user. Attachments go inline on their own turn (the last 3 with files). Cleans legacy JSON replies. Strips base64 before storage. |
| `src/attachments.ts` | Camera and gallery (expo-image-picker) and documents (expo-document-picker: PDF, txt/md/csv/json, DOCX, images). Reads base64 with expo-file-system. Extracts DOCX text with fflate. Enforces a 15 MB limit with clear errors and fixes MIME types. |
| `src/actions.ts` | Parses the `ACTIONS:` line into maps, call, SMS, WhatsApp, email, calendar (Google Calendar template link), reminder and web buttons via Linking. Opens apps by intent with no control inside them. Maps the local parser's intents to dialer and composer links, and sends everything else to the AI. |
| `src/commands.ts` | Instant local commands: remember, forget, forget all, "what do you remember", reminders (confirmation card), and open app, call or message. |
| `src/memory.ts` | AsyncStorage memory store with dedupe, a secret filter, a compact prompt summary, remember/forget parsing, and background extraction of lasting facts with flash-lite. |
| `src/reminders.ts` | expo-notifications channel and permission handling. On-device natural-language parser ("at 6pm", "in 20 min", "tomorrow 9", "every day at 8", weekdays), with flash-lite as fallback. Schedules date, daily and weekly reminders. Lists, cancels and prunes reminders that have already fired. |
| `src/updates.ts` | Reads api.github.com `releases/latest`, compares against `Application.nativeBuildVersion`, downloads the APK with `createDownloadResumable` (progress and cancel), then calls `getContentUriAsync` → IntentLauncher `INSTALL_PACKAGE` (falls back to `ACTION_VIEW`) with `FLAG_GRANT_READ_URI_PERMISSION` and the APK MIME type. Includes a shortcut to the "Install unknown apps" setting. The browser opens only from the explicit "Open release page" link. |
| `src/voice.ts` | Wrapper for expo-speech-recognition with one mic owner at a time, permission and availability checks, and friendly error text. expo-speech TTS cleans text before speaking (no markdown or links) and picks en-IN or te-IN. |

## User-reported bugs (second request)
1. **Attachments.** Camera, gallery and documents (PDF, txt, DOCX, images) now work. Files are sent as `inlineData` with the correct MIME type in the same turn as the text; DOCX and text files are sent as text. A thumbnail or file chip shows in the composer and in the message. Files over 15 MB show a clear error.
2. **Wrong answers.** Recent history (up to 24 turns) is sent in order with correct and merged roles. The system prompt goes in `systemInstruction`. Old `{direct_response…}` JSON is cleaned and the old JSON reply format is gone. Attachments stay with their own turn. Google Search grounding runs automatically for factual or current questions; the 🌐 chip switches between Auto, On and Off.
3. **TTS in the background.** It is off by default, and a settings migration forces it off for existing users. Speech only plays with 🔊 on or in Hands-Free. `Speech.stop()` runs on tab switch, on a new message, when the app goes to the background, on "■ Stop voice", on the send/stop button and on leaving Hands-Free.
4. **Hands-Free.** Rebuilt as the voice loop described above (`HandsFreeScreen.tsx`).
5. **In-app update.** Downloads inside the app with a progress bar and opens the system installer directly (`src/updates.ts`). Android's one Install confirmation is expected.

## Other fixes
- Removed the outdated `gemini-pro` / 2.5 handling (old App.tsx line ~632) and the 2.x fallback list. Saved settings with an old model are migrated.
- Removed the local intent paths that claimed success without doing anything (scroll, click, read screen, torch, "search…"). These now go to the AI, or are opened with a real intent.
- Chat no longer writes the full history, including base64 images, to AsyncStorage on every streamed token. This was a major source of lag.

## Dependencies added (match Expo SDK 52 `bundledNativeModules.json`)
- `expo-notifications` ~0.29.14
- `expo-image-picker` ~16.0.6
- `expo-document-picker` ~13.0.3
- `expo-intent-launcher` ~12.0.2
- `expo-application` ~6.0.2
- `expo-speech-recognition` ~1.1.1 (its `sdk-52` dist-tag; third-party, needs the config plugin, already added)
- `fflate` ^0.8.3 (pure JS; reads text from DOCX)

## Verification
- `npx tsc --noEmit`: **passes** (deps installed with `--ignore-scripts` in a temp copy).
- `npx expo export --platform android --no-bytecode`: **bundles** (730 modules). Hermes bytecode was skipped only because the sandbox's hermesc binary can't run.
- `npx expo config --type introspect`: plugins resolve. The manifest gets the RecognitionService queries, and `SYSTEM_ALERT_WINDOW` is marked `tools:node="remove"`.
- `node --check server/server.js server/computer.js`: OK.
- Server run against the real Playwright Chromium with a local test page:
  - `/health` returns 200. `/api/computer/state` returns 401 with no token or a wrong `?token=`, and 200 with a Bearer header or `?token=`.
  - `/wake` takes about 200 ms. Navigate works.
  - A tap at (0.1, 0.15) clicked the test button; the screenshot confirmed "Clicked" with a red background.
  - `/stream` returns `multipart/x-mixed-replace; boundary=pulseframe` with frames. `/events` delivered SSE `state` events.
  - `/task` started the agent and surfaced Gemini's "API key not valid" error (fake key) through the events. `/stop` works.

## Not done / caveats
- **Not tested on a phone.** Things to check on the OnePlus 12R:
  - MJPEG in Android WebView through the Codespaces port.
  - SSE through the GitHub tunnel. The server sends 2 KB of padding to beat buffering; the app falls back to reconnect/backoff.
  - Speech recognition, which needs Google speech services.
  - The install intent, the first time "Install unknown apps" is allowed.
- **Exact-time reminders on Android 14+** use `USE_EXACT_ALARM` (fine for a sideloaded APK; Play Store policy would object). Without it, Android may deliver reminders a few minutes late.
- **Notification icon:** there is no expo-notifications plugin, so the app icon is used as the small icon (Android may show it as a white silhouette).
- **Calling a contact by name** isn't possible because contacts aren't read. The command asks for the number instead.
- **The Hands-Free conversation** is separate from the chat thread. Both share memory.
- **README.md** was not updated with the new endpoints.
