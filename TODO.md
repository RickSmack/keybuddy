# Key Buddy — open items

## Code-review findings — auto-capture (commit b9645cf), not yet fixed

From a high-effort review of the QR-style auto-capture feature. Ordered by severity.

### Correctness
1. **Auto-capture fires during Edit** (`app.js` ~1654, `editKey`)
   Editing a key (`editKey` → `showView("add")` → `startCamera("add")` → `startAddAuto()`)
   starts the auto loop, so relabeling an existing key silently appends new auto-captured
   photos to it. Fix: only arm auto-capture for NEW adds, not edits (e.g. gate `startAddAuto`
   on `!editingId`, and re-evaluate when entering Add fresh).

2. **Manual capture races the auto loop** (`app.js` ~1467, `#addCaptureBtn`)
   The manual "Add photo" button and its `confirmLowQuality` modal don't pause the auto loop,
   so a photo can auto-commit while the modal is open. Fix: `stopAddAuto()` on manual capture
   start / while the modal is open, resume after.

3. **Motion gate misaligned with committed frame** (`app.js` ~1519)
   `addFrameMoved` compares against the frame ~320ms ago, not the stability of the frame
   actually committed; jitter between ticks resets the streak, and a motion-blurred frame can
   still commit. Fix: measure stability of the capture frame itself (e.g. two quick reads).

4. **Awaited `fingerprint()` inside the tick may commit a stale frame** (`app.js` ~1531)
   MobileNet inference takes hundreds of ms; the scene can change during it, but the committed
   canvas/thumb is from before inference. Fix: snapshot + freeze preview at flash time.

5. **No cap on auto-captured photos** (`app.js` ~1528)
   A steady/settled scene keeps arming and firing, accumulating unbounded near-duplicate photos
   (each a full canvas + fingerprint + thumb). Fix: cap auto-adds per session (e.g. 5) and stop.

### Cleanup
6. **`addFrameMoved` duplicates `detectMotion()`** (`app.js` ~1545 vs ~890)
   Same gray-downscale + abs-delta algorithm. Reuse `detectMotion` (parameterize size/threshold).

7. **`assessQuality` double `cv.imread` every ~320ms** (`app.js` ~1524)
   Two separate OpenCV pipelines (Laplacian, then Otsu+findContours) per tick — battery drain
   on a phone. Fix: share one grayscale Mat across both checks.

## Other backlog / ideas discussed
- **Blade-vs-bow isolation** within a single key (cut profile currently uses the whole key).
- **Tier 2 custom model** trained on Rick's accumulating labeled photos (Sync → Export training
  dataset already accumulates these) — the real accuracy jump, esp. for smooth/dimple/car keys
  the cut-profile approach can't handle.
- **Bitting decode (exact)** would need a real scale reference (coin/marker); the blade-width
  assumption only supports approximate depths.
- Tune capture thresholds (`BLUR_MIN`, `DARK_MIN`, glare fraction, auto-capture stability count)
  against Rick's actual phone once field-tested.
