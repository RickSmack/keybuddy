# Key Buddy — open items

## Code-review findings — auto-capture (commit b9645cf)

From a high-effort review of the QR-style auto-capture feature. Ordered by severity.

### Correctness — fixed 2026-07-21
1. **Auto-capture fires during Edit** — FIXED. Auto-capture now starts OFF whenever you open
   an existing key to edit it (`editKey` sets `addAutoSessionOn = false`); it no longer assumes
   you want new photos just because you're relabeling. A new **Auto-capture** toggle on the Add/
   Edit screen lets you turn it on for that session if you actually do want more shots.

2. **Manual capture races the auto loop** — FIXED. `#addCaptureBtn` now pauses the auto loop
   (`stopAddAuto()`) before capturing — covering the `confirmLowQuality` modal too — and resumes
   it afterward only if it was running.

3. **Motion gate misaligned with committed frame** — FIXED. Right before firing, a new
   `verifyAndCaptureAuto()` does one more close-interval (80ms) motion + quality re-check and
   commits *that* frame, instead of trusting the ~320ms-old cross-tick comparison.

4. **Awaited `fingerprint()` inside the tick may commit a stale frame** — not changed. On
   inspection this isn't a data-correctness bug (the canvas is already a frozen snapshot before
   fingerprinting starts); the real gap is UX — the live preview doesn't visually freeze during
   the ~hundreds-of-ms MobileNet inference. Still open if we want the polish: freeze `#addPreview`
   (already in the DOM, unused) over the video at flash time, swap back after commit.

5. **No cap on auto-captured photos** — FIXED. Auto-capture now stops itself after
   `ADD_AUTO_MAX = 5` photos in a session (toggle flips off, hint explains why); flip it back on
   to keep going.

### Cleanup
6. **`addFrameMoved` duplicates `detectMotion()`** — FIXED. `detectMotion(video, prevFrame,
   size, threshold)` is now a pure function; both the Identify loop and Add auto-capture call it
   and keep their own baseline frame.

7. **`assessQuality` double `cv.imread` every ~320ms** (`app.js` ~1524) — still open.
   Two separate OpenCV pipelines (Laplacian, then Otsu+findContours) per tick — battery drain
   on a phone. Fix: share one grayscale Mat across both checks.

### New: Auto-capture on/off control
Added a persistent **Auto-capture** toggle switch directly on the Add/Edit screen (next to the
manual capture button), not just buried in Settings. It mirrors the Settings-page checkbox
(`settings.autoCapture`) for the persisted default, but session state (`addAutoSessionOn`) is
tracked separately so entering Edit can start it OFF without touching your saved preference, and
the 5-photo cap can pause a session without silently flipping your global default.

**Not yet verified on-device** — this environment has no camera/runtime to test `getUserMedia`
against. Please try it on your phone: (a) edit an existing key and confirm auto-capture stays
off until you flip the toggle, (b) fresh-add a key and confirm it stops itself after 5 photos,
(c) tap manual "Add photo" mid-auto-loop and confirm no double-capture.

## Other backlog / ideas discussed
- **Blade-vs-bow isolation** within a single key (cut profile currently uses the whole key).
- **Tier 2 custom model** trained on Rick's accumulating labeled photos (Sync → Export training
  dataset already accumulates these) — the real accuracy jump, esp. for smooth/dimple/car keys
  the cut-profile approach can't handle.
- **Bitting decode (exact)** would need a real scale reference (coin/marker); the blade-width
  assumption only supports approximate depths.
- Tune capture thresholds (`BLUR_MIN`, `DARK_MIN`, glare fraction, auto-capture stability count)
  against Rick's actual phone once field-tested.
