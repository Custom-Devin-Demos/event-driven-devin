---
name: testing-oncall-skins
description: How to run and verify On-Call customer skins (/oncall/c/<slug>) end-to-end, including the native-page variant, shim rerouting, report portal, and mobile checks.
---

# Testing On-Call Customer Skins

## Server
```bash
PORT=3100 SLACK_ONCALL_ALERTS_CHANNEL_ID=<alerts-ch> SLACK_ONCALL_BUGS_CHANNEL_ID=<bugs-ch> node app/server.js
```
A Slack token must be in env: `SLACK_ONCALL_BOT_TOKEN`, or `SLACK_BOT_TOKEN` as fallback (`app/services/oncall.js` reads `SLACK_ONCALL_BOT_TOKEN || SLACK_BOT_TOKEN`). **Restart after any edit to `config/oncall-skins.js`** (config is loaded at require time). Kill anything already on the port first (`fuser 3100/tcp`).

## What to verify per skin
- `/oncall/c/<slug>`: disclaimer bar is the FIRST body element, page title matches `page.title` (for native pages the shim never rewrites the title — this checks the HTML file's own `<title>`, which must be kept in sync with the config), CTA background equals `theme['--accent']`, no "← All Demos" link (the brand shim removes `.back-link` for every skin, stock or native).
- Submitting the primary action must hit the vertical's on-call endpoint (the shim in the page rewrites the legacy API path): banking → `/api/oncall/banking/transfer`, telco → `/api/oncall/telco/upgrade`, hightech → `/api/oncall/licenses/provision` (not `/api/oncall/hightech/...`), insurance → `/api/oncall/insurance/claim`, voice → `/api/oncall/voice/transcribe`. It must take ~7–10s (`durationMs` in the JSON server log). The floating "Devin On-Call demo" ribbon shows "Alert posted to #oncall-alerts".
- The Industrials stock page must preserve `quoteForm`, `submitBtn`, `result`, and the site selector element IDs, and its site selector must default to `f3-mesa` in the markup. A custom `page.file` replacing the stock page must reproduce those IDs and the `f3-mesa` default or the degraded-path check silently exercises the healthy path.
- `/oncall/c/<slug>/report`: supportCenter branding; selecting a product pre-fills persona/severity and template text from `bugPortal` config; one submit → one "On-Call bug report posted" log line with the bugs channel id.
- Regression: `/oncall` and `/oncall/report` stay generic (no customer strings); unknown slugs 404; legacy `/` hub and `/<vertical>` pages unchanged (still POST to legacy API path).
- Alert secrecy on the hightech on-call path: the Slack alert card must be metric-shaped only (monitor/threshold/baseline/metric value) with no stack trace, `TypeError`, `.js:`, `at Object.`, or `app/services` path. Note the shared hightech scenario baseline string in `app/services/oncall.js` hardcodes the stock release marker `novasoft@1.0.3`, so a customer-skinned alert card will still leak that stock brand token — flag it as a cosmetic branding leak rather than assuming the skin is wrong.
- Mobile: emulate width 390 via CDP `Emulation.setDeviceMetricsOverride`; check `document.documentElement.scrollWidth <= 390` and CTA `getBoundingClientRect().height >= 44`. Native skins tend to pass (48px CTA); the shared *stock* vertical pages may render a ~39px CTA — check both surfaces separately and report stock-page shortfalls as cosmetic, not blocking.

## Voice (dictation) specifics
- Voice pages (`voice.html` stock, or a native skin page) must preserve the IDs `transcribeForm`, `micBtn`, `utterance`, `workspace`, `dictionary`, `submitBtn`, `result` and POST to the legacy `/api/voice/transcribe` (shim reroutes to `/api/oncall/voice/transcribe`). Finalization must take real wall-clock (~6–8s in `durationMs`); the response body must contain only transcript/wordCount/termsApplied/learnedTerms-shaped fields, no cache or normalization internals.
- Dictation input uses the Web Speech API when available (Chrome's `SpeechRecognition` needs Google cloud egress; it may be unavailable on this box). To voice-test without a mic, relaunch Chrome with `--use-fake-device-for-media-capture --use-file-for-fake-audio-capture=/path/utterance.wav` (generate the WAV locally, e.g. `espeak -w`). If recognition is unavailable, verify the typed-utterance fallback and report browser transcription as untested.
- To prove an audio→text→finalize path without Google's recognizer: `pip install piper-tts`, `python3 -m piper.download_voices en_US-lessac-medium`, synthesize the utterance WAV, build whisper.cpp (`cmake --build build --target whisper-cli`) with the `small.en` model (base.en mis-hears espeak/robotic audio), transcribe, and type the STT output into the utterance box before finalizing. To make the audio path visible in a recording, play the WAV in-frame with `ffplay` (start PulseAudio with a null sink first: `pulseaudio --start && pactl load-module module-null-sink sink_name=VirtualSpeaker` — the box has no physical ALSA device) and run whisper.cpp in a large-font visible terminal so its live transcript appears on screen.
- **Recording annotation convention for voice tests: stream the "audio" as text.** The recording has no sound, so at each dictation step add `annotate_recording` entries that quote the exact words being "spoken" (e.g. setup annotation `Dictating: "okay quick update comma the api migration is on track period"`), then an assertion quoting the finalized transcript so the viewer can compare spoken input vs normalized output.

## Industrials (mTLS edge) specifics
- `industrials-edge.js` generates cert material with `openssl` at boot (~1.0s after listen), then rotates the enrolled site leaves. Wait for three `Industrial edge client certificate loaded` log lines and the rotation lines before timing the first quote, or you will be timing keygen.
- Expected timings: `f3-mesa` (markup default) ~14.2s and STILL SUCCEEDS green (edge ~2.3s + cloud fallback ~11.9s); `f2-torrance`/`f4-alabama` ~0.31s. An error box on F3 is a failure.
- The certificate recovery check is one code change plus one restart: add the affected site to the edge rotation enrollment, restart, wait for its `Industrial edge client certificate rotated` line, then confirm its quote completes through the edge path at ~0.31s.
- `ROTATION_ENROLLMENT` in `industrials-edge.js` decides which site is degraded: all leaves start lapsed, enrolled sites are re-issued for 30 days and log `Industrial edge client certificate rotated`, so the fast/slow contrast changes with one line plus a restart.
- 14s is invisible in stills: inject a submit-triggered stopwatch overlay via CDP (`#quoteForm` submit listener + MutationObserver on `#result`) so the recording shows measured wall-clock.
- Two-hop causality check: only `service: industrials-edge-gateway` lines may contain `CERT_HAS_EXPIRED` (plus `clientCertSubjectCn`, `clientCertNotAfter`, `site`); the `quote-api` client side must show only `code: ECONNRESET` / `socket hang up`.
- Secrecy check on the client response body: it must contain only `success/quoteId/status/site/factory/estimate` — no `fallback`, `phaseTimings`, `cloudQueueMs`, `cert`, `mtls`, `tls`, `queue`, `k3s`, `eks`. Differing `leadTimeDays` (18 degraded vs 12 healthy) is intentional.
- Legacy `/industrials` (CMMS work-order page) is a different vertical and still throws its planted TypeError; the visible message may read `Cannot read properties of undefined (reading 'rates')` rather than `laborRate` — either wording is the expected planted error, not a regression.

## Browser/CDP gotchas on this box
- Typing into Chrome's URL bar via computer-use keyboard may silently not register. Workaround: navigate with CDP `Page.navigate`.
- The built-in browser_console/read_dom CDP tools may fail with "Could not connect". Launch Chrome yourself with `--remote-debugging-port=9222` and drive CDP via python `websocket-client` (`pip3 install websocket-client`) using `create_connection(url, suppress_origin=True)` — otherwise Chrome 403s the handshake unless `--remote-allow-origins=*` was passed.
- CDP `Emulation.setDeviceMetricsOverride` is reverted when the websocket session closes — keep the connection open while taking OS-level screenshots of the emulated view. Real window resize won't go below ~500px width.
- `lsof` is not installed; use `fuser <port>/tcp`.
- For PR-ready screenshots with no browser chrome or cursor, use CDP `Page.captureScreenshot` with `captureBeyondViewport: true`. Hide the injected demo furniture first (`document.getElementById('oncall-ribbon').style.display='none'` and remove any stopwatch overlay you injected), otherwise the floating "Devin On-Call demo" ribbon lands in the marketing shot.
- Live-site vs clone comparison: navigate the same CDP session to the real customer site, capture a viewport screenshot, and stitch the two with PIL into one side-by-side PNG. Expect cosmetic deviations that are NOT bugs: the logo glyph is usually a hand-rolled SVG approximation, and brand webfonts are typically unavailable so the clone falls back to a Google font. Report those as cosmetic and check the structural signals instead (announce/nav bar colors, accent hex on the CTA, hero gradient, footer treatment).

## Devin Secrets Needed
`SLACK_ONCALL_BOT_TOKEN` (present). `SLACK_ONCALL_ALERTS_CHANNEL_ID` and `SLACK_ONCALL_BUGS_CHANNEL_ID` may be ABSENT — then alert/bug triggers return `{ok:false,skipped:true}` and log `... channel not configured — skipping ...`. That is clean expected behavior; Slack card rendering simply cannot be verified without those two channel IDs.
