"use strict";
/* ============================================================
   Key Buddy — all app logic (kept inline for single-file delivery)
   Data lives in IndexedDB on THIS device only; the file ships blank.
   ============================================================ */

/* ---------- tiny helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
// Null-safe event binding: if the element is missing (e.g. a stale cached
// index.html paired with a newer app.js), skip it instead of throwing and
// taking down the whole app at boot.
function on(sel, type, handler, opts) {
  const el = $(sel);
  if (el) el.addEventListener(type, handler, opts);
  else console.warn("Key Buddy: missing element for listener", sel);
  return el;
}
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

/* ---------- IndexedDB layer ---------- */
const DB_NAME = "keybuddy";
const STORE = "keys";
let _db;
function db() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) {
        d.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}
// Run one request against the store and resolve with its result.
async function req(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const request = fn(t.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
const putKey = (key) => req("readwrite", (s) => s.put(key));
const deleteKey = (id) => req("readwrite", (s) => s.delete(id));
const getAllKeys = () => req("readonly", (s) => s.getAll()).then((r) => r || []).catch(() => []);
const getKey = (id) => req("readonly", (s) => s.get(id)).then((r) => r || null).catch(() => null);
function uid() {
  return "k_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/* ---------- model loading ---------- */
// Self-hosted MobileNet v1 (1.0/224). We load the full layers model and build an
// intermediate model that outputs the 1024-d global-average-pool embedding.
let embedModel = null;       // tf model: image -> 1024-d embedding
let modelState = "loading";  // loading | ready | error
const EMBED_LAYER = "global_average_pooling2d_1";
function setModelStatus(state, label) {
  modelState = state;
  const dot = $("#modelDot");
  dot.className = "dot " + (state === "ready" ? "ready" : state === "error" ? "error" : "loading");
  $("#modelLabel").textContent = label;
}
async function loadModel() {
  setModelStatus("loading", "preparing…");
  try {
    await tf.ready();
    // The model weights are a one-time ~17 MB download (then cached offline).
    // Show percent so the first load never looks frozen.
    const full = await tf.loadLayersModel("vendor/mobilenet/model.json", {
      onProgress: (frac) => setModelStatus("loading", `downloading model ${Math.round(frac * 100)}%`),
    });
    setModelStatus("loading", "warming up…");
    const embedLayer = full.getLayer(EMBED_LAYER);
    embedModel = tf.model({ inputs: full.inputs, outputs: embedLayer.output });
    const warm = tf.zeros([1, CAP, CAP, 3]);
    embedModel.predict(warm).dispose();
    warm.dispose();
    setModelStatus("ready", "ready");
    // Now that the app is interactive, warm OpenCV in the background so the
    // background-masking preprocessing is ready before the first capture.
    ensureOpenCV();
  } catch (e) {
    console.error(e);
    setModelStatus("error", "model offline");
    toast("Model failed to load — matching uses shape only until reload.");
  }
}

/* ---------- image / fingerprint pipeline ---------- */
const CAP = 224; // working square size

// Draw a source (video/img/canvas) center-cropped square into a canvas at CAP size.
function toWorkCanvas(src, sw, sh) {
  const c = document.createElement("canvas");
  c.width = CAP; c.height = CAP;
  const ctx = c.getContext("2d");
  const side = Math.min(sw, sh);
  const sx = (sw - side) / 2, sy = (sh - side) / 2;
  ctx.drawImage(src, sx, sy, side, side, 0, 0, CAP, CAP);
  return c;
}

/* ---------- Tier 0: OpenCV preprocessing (lazy-loaded) ---------- */
// OpenCV.js is ~10 MB, so we don't load it up front. It's fetched in the
// background the first time we fingerprint a key; until it's ready, captures
// still work using the plain crop (matching just isn't background-masked yet).
let cvReady = false;
let cvRequested = false;
function ensureOpenCV() {
  if (cvRequested || typeof document === "undefined") return;
  cvRequested = true;
  const s = document.createElement("script");
  s.src = "vendor/opencv.js";
  s.async = true;
  s.onload = () => {
    const poll = setInterval(() => {
      if (window.cv && cv.Mat) { cvReady = true; clearInterval(poll); }
    }, 150);
    setTimeout(() => clearInterval(poll), 20000);
  };
  document.head.appendChild(s);
}

// Neutral fill for masked-out (non-key) pixels — mid-gray so the embedding
// treats it as "nothing" rather than a feature.
const MASK_FILL = 128;

// Use OpenCV to isolate the KEY ITSELF from background/keychain/surface:
//   1. find the dominant key contour (largest external region)
//   2. build a filled mask of that contour and blank everything outside it
//   3. deskew via the contour's min-area rect and tighten the crop
// Returns a CAP-square canvas with the key on a neutral field. Falls back to
// the plain center crop if OpenCV isn't ready or no confident contour is found.
function refineKeyCrop(workCanvas) {
  if (!cvReady) { ensureOpenCV(); return workCanvas; } // load in bg; use plain crop meanwhile
  let src, gray, blur, edges, contours, hier, mask, masked, rotated, maskRot, roi, M;
  try {
    src = cv.imread(workCanvas);
    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    blur = new cv.Mat();
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    edges = new cv.Mat();
    cv.threshold(blur, edges, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    // largest contour by area (drops keychain rings and background specks)
    contours = new cv.MatVector();
    hier = new cv.Mat();
    cv.findContours(edges, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let best = -1, bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const a = cv.contourArea(contours.get(i));
      if (a > bestArea) { bestArea = a; best = i; }
    }
    const frameArea = workCanvas.width * workCanvas.height;
    if (best < 0 || bestArea < frameArea * 0.02 || bestArea > frameArea * 0.95) {
      return workCanvas;
    }

    // 1) Build a filled mask of ONLY the key contour.
    mask = cv.Mat.zeros(src.rows, src.cols, cv.CV_8UC1);
    const white = new cv.Scalar(255);
    cv.drawContours(mask, contours, best, white, -1); // -1 = filled
    // slight dilation so we keep the key's own edge, not shave it
    const k = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(mask, mask, k); k.delete();

    // 2) Composite: key pixels kept, everything else set to neutral gray.
    masked = new cv.Mat(src.rows, src.cols, cv.CV_8UC4, new cv.Scalar(MASK_FILL, MASK_FILL, MASK_FILL, 255));
    src.copyTo(masked, mask);

    // 3) Deskew via the contour's min-area rect.
    const rect = cv.minAreaRect(contours.get(best));
    let angle = rect.angle;
    let w = rect.size.width, h = rect.size.height;
    if (w < h) { [w, h] = [h, w]; angle += 90; } // long axis horizontal
    M = cv.getRotationMatrix2D(rect.center, angle, 1);
    rotated = new cv.Mat();
    cv.warpAffine(masked, rotated, M, new cv.Size(src.cols, src.rows),
      cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(MASK_FILL, MASK_FILL, MASK_FILL, 255));

    // crop the upright bounding box (with small padding)
    const padW = w * 0.08, padH = h * 0.08;
    const rw = Math.min(src.cols, Math.round(w + padW * 2));
    const rh = Math.min(src.rows, Math.round(h + padH * 2));
    const cx = Math.round(rect.center.x), cy = Math.round(rect.center.y);
    let x = Math.max(0, cx - Math.round(rw / 2));
    let y = Math.max(0, cy - Math.round(rh / 2));
    x = Math.min(x, src.cols - rw); y = Math.min(y, src.rows - rh);
    roi = rotated.roi(new cv.Rect(x, y, rw, rh));

    // letterbox roi into a CAP square on a neutral field
    const out = document.createElement("canvas");
    out.width = CAP; out.height = CAP;
    const octx = out.getContext("2d");
    octx.fillStyle = `rgb(${MASK_FILL},${MASK_FILL},${MASK_FILL})`;
    octx.fillRect(0, 0, CAP, CAP);
    const tmp = document.createElement("canvas");
    cv.imshow(tmp, roi);
    const s = Math.min(CAP / tmp.width, CAP / tmp.height);
    const dw = tmp.width * s, dh = tmp.height * s;
    octx.drawImage(tmp, (CAP - dw) / 2, (CAP - dh) / 2, dw, dh);
    return out;
  } catch (e) {
    return workCanvas; // any OpenCV hiccup → safe fallback
  } finally {
    [src, gray, blur, edges, hier, mask, masked, rotated, maskRot, roi, M].forEach(
      (m) => { try { m && m.delete(); } catch (_) {} });
    try { contours && contours.delete(); } catch (_) {}
  }
}

// Small JPEG thumbnail for storage/display.
function canvasToThumb(canvas, size = 160) {
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  c.getContext("2d").drawImage(canvas, 0, 0, size, size);
  return c.toDataURL("image/jpeg", 0.7);
}

// Otsu threshold on grayscale to isolate the key silhouette (assumes plain bg).
function silhouette(canvas) {
  const ctx = canvas.getContext("2d");
  const { data } = ctx.getImageData(0, 0, CAP, CAP);
  const gray = new Uint8Array(CAP * CAP);
  const hist = new Array(256).fill(0);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const g = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    gray[p] = g; hist[g]++;
  }
  // Otsu
  const total = CAP * CAP;
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, max = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) { max = between; thr = t; }
  }
  // Decide polarity: key is the minority region typically; treat darker OR lighter as foreground
  let darkCount = 0; for (let p = 0; p < total; p++) if (gray[p] < thr) darkCount++;
  const keyIsDark = darkCount < total / 2;
  const mask = new Uint8Array(total);
  for (let p = 0; p < total; p++) {
    const fg = keyIsDark ? gray[p] < thr : gray[p] >= thr;
    mask[p] = fg ? 1 : 0;
  }
  return mask;
}

// Column-profile "bitting-ish" descriptor + normalized bbox aspect. 32 buckets.
function shapeDescriptor(mask) {
  const N = 32;
  const colTop = new Array(CAP).fill(-1);
  const colBot = new Array(CAP).fill(-1);
  let minX = CAP, maxX = -1, minY = CAP, maxY = -1;
  for (let x = 0; x < CAP; x++) {
    for (let y = 0; y < CAP; y++) {
      if (mask[y * CAP + x]) {
        if (colTop[x] < 0) colTop[x] = y;
        colBot[x] = y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  const prof = new Array(N).fill(0);
  for (let b = 0; b < N; b++) {
    const x = Math.round(minX + (b / (N - 1)) * w);
    if (colTop[x] >= 0) prof[b] = (colBot[x] - colTop[x]) / h; // relative thickness
  }
  return { profile: prof, aspect: w / h };
}

// 8x8 average-hash perceptual hash from grayscale.
function pHash(canvas) {
  const c = document.createElement("canvas"); c.width = 8; c.height = 8;
  c.getContext("2d").drawImage(canvas, 0, 0, 8, 8);
  const d = c.getContext("2d").getImageData(0, 0, 8, 8).data;
  const g = [];
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) { const v = d[i] * .299 + d[i+1]*.587 + d[i+2]*.114; g.push(v); sum += v; }
  const avg = sum / 64;
  return g.map((v) => (v > avg ? 1 : 0));
}

// Full fingerprint from a work canvas.
// refine=true (default) runs Tier-0 OpenCV deskew/tighten first; pass false for
// inputs that are already tightly cropped (e.g. Find-in-Pile blobs).
async function fingerprint(workCanvas, refine = true) {
  if (refine) workCanvas = refineKeyCrop(workCanvas);
  const fp = { phash: pHash(workCanvas) };
  const mask = silhouette(workCanvas);
  fp.shape = shapeDescriptor(mask);
  if (embedModel) {
    const emb = tf.tidy(() => {
      // MobileNet v1 expects inputs scaled to [-1, 1].
      const t = tf.browser.fromPixels(workCanvas).toFloat()
        .div(127.5).sub(1).expandDims(0);
      return embedModel.predict(t).flatten();
    });
    const arr = await emb.data();
    emb.dispose();
    fp.embedding = Array.from(arr);
  }
  return fp;
}

/* ---------- pile segmentation (Find in Pile) ---------- */
// Analyze a full photo: threshold, label connected blobs, keep key-sized ones,
// and return { canvas, W, H, blobs:[{x,y,w,h,area}] } at a working resolution.
function segmentPile(src, sw, sh) {
  const MAXW = 480; // working width; keeps CC fast on phones
  const scale = Math.min(1, MAXW / sw);
  const W = Math.round(sw * scale), H = Math.round(sh * scale);
  const work = document.createElement("canvas");
  work.width = W; work.height = H;
  const ctx = work.getContext("2d");
  ctx.drawImage(src, 0, 0, W, H);
  const data = ctx.getImageData(0, 0, W, H).data;

  // grayscale + Otsu threshold (reused idea from silhouette)
  const total = W * H;
  const gray = new Uint8Array(total);
  const hist = new Array(256).fill(0);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const g = (data[i] * .299 + data[i+1] * .587 + data[i+2] * .114) | 0;
    gray[p] = g; hist[g]++;
  }
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, max = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) { max = between; thr = t; }
  }
  let darkCount = 0; for (let p = 0; p < total; p++) if (gray[p] < thr) darkCount++;
  const keyIsDark = darkCount < total / 2; // keys are the minority foreground
  const fg = new Uint8Array(total);
  for (let p = 0; p < total; p++) fg[p] = (keyIsDark ? gray[p] < thr : gray[p] >= thr) ? 1 : 0;

  // connected components (4-neighbour flood fill via stack)
  const labels = new Int32Array(total).fill(0);
  const blobs = [];
  const stack = [];
  let next = 0;
  for (let start = 0; start < total; start++) {
    if (!fg[start] || labels[start]) continue;
    next++;
    let minX = W, minY = H, maxX = 0, maxY = 0, area = 0;
    stack.push(start); labels[start] = next;
    while (stack.length) {
      const p = stack.pop();
      const x = p % W, y = (p / W) | 0;
      area++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0     && fg[p-1] && !labels[p-1]) { labels[p-1] = next; stack.push(p-1); }
      if (x < W-1   && fg[p+1] && !labels[p+1]) { labels[p+1] = next; stack.push(p+1); }
      if (y > 0     && fg[p-W] && !labels[p-W]) { labels[p-W] = next; stack.push(p-W); }
      if (y < H-1   && fg[p+W] && !labels[p+W]) { labels[p+W] = next; stack.push(p+W); }
    }
    blobs.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area });
  }
  // Keep plausibly key-sized blobs: not too tiny (noise), not the whole frame (background).
  const minArea = total * 0.002, maxArea = total * 0.6;
  const kept = blobs.filter((b) => b.area >= minArea && b.area <= maxArea && b.w > 6 && b.h > 6);
  return { canvas: work, W, H, blobs: kept };
}

// Crop a blob (with padding) out of the working canvas into a CAP-square canvas.
function cropBlob(workCanvas, b) {
  const pad = Math.round(Math.max(b.w, b.h) * 0.12);
  const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
  const w = Math.min(workCanvas.width - x, b.w + pad * 2);
  const h = Math.min(workCanvas.height - y, b.h + pad * 2);
  const c = document.createElement("canvas");
  c.width = CAP; c.height = CAP;
  // letterbox the blob into the square so aspect is preserved
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, CAP, CAP);
  const s = Math.min(CAP / w, CAP / h);
  const dw = w * s, dh = h * s;
  ctx.drawImage(workCanvas, x, y, w, h, (CAP - dw) / 2, (CAP - dh) / 2, dw, dh);
  return c;
}

/* ---------- similarity ---------- */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
function profileSim(a, b) {
  if (!a || !b) return 0;
  let sse = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sse += d * d; }
  const rmse = Math.sqrt(sse / a.length);
  return Math.max(0, 1 - rmse); // 0..1
}
function hammingSim(a, b) {
  if (!a || !b) return 0;
  let same = 0; for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}
// Combined score of a probe fingerprint vs one stored fingerprint.
function fpScore(probe, stored) {
  const emb = probe.embedding && stored.embedding ? cosine(probe.embedding, stored.embedding) : null;
  const shp = profileSim(probe.shape?.profile, stored.shape?.profile);
  const asp = stored.shape && probe.shape
    ? Math.max(0, 1 - Math.abs(probe.shape.aspect - stored.shape.aspect) / 1.5) : 0;
  const ph = hammingSim(probe.phash, stored.phash);
  if (emb === null) {
    // no model: rely on shape + phash
    return 0.55 * shp + 0.20 * asp + 0.25 * ph;
  }
  return 0.60 * emb + 0.22 * shp + 0.08 * asp + 0.10 * ph;
}
// Best score of probe vs a key (which may hold several fingerprints).
function keyScore(probe, key) {
  let best = 0;
  for (const sfp of key.fingerprints || []) best = Math.max(best, fpScore(probe, sfp));
  return best;
}

/* ---------- camera ---------- */
const cams = {}; // viewName -> {stream, video, wrap, usesFile}
async function startCamera(view) {
  const video = $("#" + view + "Video");
  const wrap = $("#" + view + "CameraWrap");
  const fileInput = $("#" + view + "FileInput");
  cams[view] = cams[view] || {};
  cams[view].video = video; cams[view].wrap = wrap; cams[view].fileInput = fileInput;
  if (cams[view].stream) return; // already running
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } }, audio: false,
    });
    cams[view].stream = stream;
    cams[view].usesFile = false;
    video.srcObject = stream;
    video.hidden = false;
    await video.play().catch(() => {});
  } catch (e) {
    // Fallback to file capture (e.g. no permission / insecure context)
    cams[view].usesFile = true;
    video.hidden = true;
    if (view === "id") {
      // no live preview → force manual capture regardless of auto-scan setting
      stopIdLoop();
      $("#idResumeBtn").hidden = true;
      $("#idFallbackHint").hidden = false;
      $("#idCaptureBtn").hidden = false;
      $("#idGuideText").textContent = "Tap Capture to take a photo";
    }
  }
}
function stopCamera(view) {
  const c = cams[view];
  if (c?.stream) { c.stream.getTracks().forEach((t) => t.stop()); c.stream = null; }
}
// Capture a work canvas from a view's camera, or open file picker (returns Promise<canvas|null>).
function capture(view) {
  return new Promise((resolve) => {
    const c = cams[view];
    if (c && !c.usesFile && c.stream && c.video.videoWidth) {
      resolve(toWorkCanvas(c.video, c.video.videoWidth, c.video.videoHeight));
      return;
    }
    // file fallback
    const fi = $("#" + view + "FileInput");
    fi.value = "";
    fi.onchange = () => {
      const f = fi.files[0];
      if (!f) return resolve(null);
      const img = new Image();
      img.onload = () => resolve(toWorkCanvas(img, img.naturalWidth, img.naturalHeight));
      img.onerror = () => resolve(null);
      img.src = URL.createObjectURL(f);
    };
    fi.click();
  });
}

// Capture the FULL frame (not center-cropped) as a canvas — used by Find in Pile,
// which needs the whole scene to locate keys. Downscales very large frames.
function captureFull(view) {
  const drawFull = (srcW, srcH, drawFn) => {
    const MAX = 1280;
    const scale = Math.min(1, MAX / Math.max(srcW, srcH));
    const c = document.createElement("canvas");
    c.width = Math.round(srcW * scale); c.height = Math.round(srcH * scale);
    drawFn(c.getContext("2d"), c.width, c.height);
    return c;
  };
  return new Promise((resolve) => {
    const c = cams[view];
    if (c && !c.usesFile && c.stream && c.video.videoWidth) {
      resolve(drawFull(c.video.videoWidth, c.video.videoHeight,
        (ctx, w, h) => ctx.drawImage(c.video, 0, 0, w, h)));
      return;
    }
    const fi = $("#" + view + "FileInput");
    fi.value = "";
    fi.onchange = () => {
      const f = fi.files[0];
      if (!f) return resolve(null);
      const img = new Image();
      img.onload = () => resolve(drawFull(img.naturalWidth, img.naturalHeight,
        (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h)));
      img.onerror = () => resolve(null);
      img.src = URL.createObjectURL(f);
    };
    fi.click();
  });
}

/* ---------- settings (persisted in localStorage) ---------- */
const SETTINGS_KEY = "keybuddy.settings";
const DEFAULT_SETTINGS = {
  autoScan: true,
  pauseMode: "both",   // "both" | "activity" | "time" | "never"
  motionSecs: 10,      // pause after this many seconds with no motion
  timeSecs: 25,        // pause after this many total seconds
};
let settings = loadSettings();
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch (_) { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
}

function renderSettings() {
  $("#setAutoScan").checked = settings.autoScan;
  $("#setPauseMode").value = settings.pauseMode;
  $("#setMotionSecs").value = settings.motionSecs;
  $("#setMotionSecsVal").textContent = settings.motionSecs + "s";
  $("#setTimeSecs").value = settings.timeSecs;
  $("#setTimeSecsVal").textContent = settings.timeSecs + "s";
  // enable/disable dependent controls
  $("#autoScanOpts").classList.toggle("disabled", !settings.autoScan);
  const mode = settings.pauseMode;
  $("#setMotionRow").style.display = (mode === "activity" || mode === "both") ? "" : "none";
  $("#setTimeRow").style.display = (mode === "time" || mode === "both") ? "" : "none";
}
on("#setAutoScan", "change", (e) => { settings.autoScan = e.target.checked; saveSettings(); renderSettings(); });
on("#setPauseMode", "change", (e) => { settings.pauseMode = e.target.value; saveSettings(); renderSettings(); });
on("#setMotionSecs", "input", (e) => { settings.motionSecs = +e.target.value; $("#setMotionSecsVal").textContent = settings.motionSecs + "s"; saveSettings(); });
on("#setTimeSecs", "input", (e) => { settings.timeSecs = +e.target.value; $("#setTimeSecsVal").textContent = settings.timeSecs + "s"; saveSettings(); });

/* ---------- navigation ---------- */
function showView(name) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  $$("nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  // camera lifecycle — map each camera key to the view that uses it
  const CAM_VIEW = { id: "identify", add: "add", find: "find" };
  Object.entries(CAM_VIEW).forEach(([camKey, viewName]) => {
    if (viewName === name) startCamera(camKey); else stopCamera(camKey);
  });
  // auto-identify loop only runs on the Identify view (and only if enabled)
  if (name === "identify") enterIdentify(); else stopIdLoop();
  if (name === "add") { refreshCategoryList(); refreshLocationList(); }
  if (name === "keys") renderKeys();
  if (name === "sync") renderStats();
  if (name === "settings") renderSettings();
}
$$("nav button").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

/* ---------- IDENTIFY flow (continuous auto-identify) ---------- */
let idLoopActive = false;   // loop should keep running
let idBusy = false;         // an inference is in flight
let lastProbe = null, lastCanvas = null;
let scanStartedAt = 0;      // when the current scanning run began
let lastMotionAt = 0;       // last time motion was detected
let motionPrev = null;      // previous downscaled frame for motion diff
let idFrozen = false;       // true once the user captures — ranking is held still
let smoothScores = {};      // keyId -> smoothed score (EMA across frames)
const ID_INTERVAL = 1200;   // ms between inference attempts
const MOTION_THRESH = 8;    // mean per-pixel gray delta counted as "motion"
const SCORE_EMA = 0.5;      // smoothing weight for new frames (0..1; lower = steadier)

// Called when entering the Identify view: start auto-scan if enabled,
// otherwise fall back to the manual capture button.
function enterIdentify() {
  const c = cams.id;
  if (settings.autoScan && !(c && c.usesFile)) {
    startIdLoop();
  } else {
    stopIdLoop();
    $("#idResumeBtn").hidden = true;
    $("#idCaptureBtn").hidden = false;
    $("#idGuideText").textContent = "Tap Capture to identify a key";
  }
}

function startIdLoop() {
  if (idLoopActive) return;
  idLoopActive = true;
  idFrozen = false;
  smoothScores = {};          // start smoothing fresh each scan session
  const now = performance.now();
  scanStartedAt = now;
  lastMotionAt = now;
  motionPrev = null;
  hideScanPaused();
  // While scanning live: show the "capture/lock in" button, hide the retry button.
  $("#idCaptureBtn").hidden = false;
  $("#idCaptureBtn").innerHTML = "🔒 Lock in this guess";
  $("#idRetryBtn").hidden = true;
  $("#idResults").innerHTML = "";
  $("#idGuideText").textContent = "Point at a key — matching automatically…";
  scheduleIdTick(300);
}
function stopIdLoop() { idLoopActive = false; }
function pauseIdLoop(reason) {
  idLoopActive = false;
  showScanPaused(reason);
}
function scheduleIdTick(delay) {
  if (!idLoopActive) return;
  setTimeout(idTick, delay);
}
function showScanPaused(reason) {
  $("#idGuideText").textContent = reason === "motion"
    ? "Paused (no motion) — tap to resume"
    : "Scanning paused to save battery";
  const btn = $("#idResumeBtn");
  if (btn) btn.hidden = false;
}
function hideScanPaused() {
  const btn = $("#idResumeBtn");
  if (btn) btn.hidden = true;
}

// Cheap frame-to-frame motion: mean absolute gray delta on a 32x32 downscale.
function detectMotion(video) {
  const S = 32;
  const c = document.createElement("canvas"); c.width = S; c.height = S;
  const ctx = c.getContext("2d");
  ctx.drawImage(video, 0, 0, S, S);
  const d = ctx.getImageData(0, 0, S, S).data;
  const cur = new Uint8Array(S * S);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) cur[p] = (d[i] * .299 + d[i+1] * .587 + d[i+2] * .114) | 0;
  let moved = false;
  if (motionPrev) {
    let sum = 0;
    for (let p = 0; p < cur.length; p++) sum += Math.abs(cur[p] - motionPrev[p]);
    if (sum / cur.length > MOTION_THRESH) moved = true;
  }
  motionPrev = cur;
  return moved;
}

// Decide whether to auto-pause based on the user's settings.
function shouldPause() {
  const now = performance.now();
  const mode = settings.pauseMode;
  const timeUp = (now - scanStartedAt) > settings.timeSecs * 1000;
  const idle = (now - lastMotionAt) > settings.motionSecs * 1000;
  if (mode === "never") return null;
  if (mode === "time") return timeUp ? "time" : null;
  if (mode === "activity") return idle ? "motion" : null;
  // "both": whichever triggers first
  if (idle) return "motion";
  if (timeUp) return "time";
  return null;
}

async function idTick() {
  if (!idLoopActive) return;
  const c = cams.id;
  // Only auto-scan with a live camera; file fallback uses the manual button.
  if (!c || c.usesFile || !c.stream || !c.video.videoWidth || idBusy || modelState === "loading") {
    scheduleIdTick(ID_INTERVAL);
    return;
  }
  // Motion tracking + settings-driven auto-pause.
  if (detectMotion(c.video)) lastMotionAt = performance.now();
  const pauseReason = shouldPause();
  if (pauseReason) { pauseIdLoop(pauseReason); return; }
  idBusy = true;
  try {
    const canvas = toWorkCanvas(c.video, c.video.videoWidth, c.video.videoHeight);
    const probe = await fingerprint(canvas);
    lastProbe = probe; lastCanvas = canvas;
    // Identify against ALL keys, including decommissioned ones — a key you're
    // holding may well be one that was previously decommissioned.
    const keys = await getAllKeys();
    // Smooth each key's score over frames (EMA) so ranking doesn't flip on noise.
    const seen = new Set();
    keys.forEach((k) => {
      const raw = keyScore(probe, k);
      const prev = smoothScores[k.id];
      smoothScores[k.id] = prev == null ? raw : prev + SCORE_EMA * (raw - prev);
      seen.add(k.id);
    });
    Object.keys(smoothScores).forEach((id) => { if (!seen.has(id)) delete smoothScores[id]; });
    const ranked = keys.map((k) => ({ key: k, score: smoothScores[k.id] }))
      .sort((a, b) => b.score - a.score).slice(0, 3);
    if (!idFrozen) renderIdResults(ranked); // don't re-render once the user locks in
  } catch (e) {
    /* transient frame error — just try again next tick */
  } finally {
    idBusy = false;
    scheduleIdTick(ID_INTERVAL);
  }
}

// Resume scanning after an auto-pause (button or tapping the camera view).
on("#idResumeBtn", "click", startIdLoop);
on("#idCameraWrap", "click", () => {
  const c = cams.id;
  if (settings.autoScan && !idLoopActive && c && !c.usesFile) startIdLoop();
});

// Capture button. Two modes:
//  - Live auto-scan: "Lock in this guess" — freeze the current ranking so it
//    stops re-ordering while you verify. Retry button resumes scanning.
//  - File fallback (no live camera): capture a photo and identify once.
on("#idCaptureBtn", "click", async () => {
  const c = cams.id;
  const liveScanning = idLoopActive && c && !c.usesFile;
  if (liveScanning) { freezeIdResults(); return; }

  const btn = $("#idCaptureBtn");
  const canvas = await capture("id");
  if (!canvas) return;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Analyzing…';
  try {
    const probe = await fingerprint(canvas);
    lastProbe = probe; lastCanvas = canvas;
    const keys = await getAllKeys();
    smoothScores = {};
    keys.forEach((k) => { smoothScores[k.id] = keyScore(probe, k); });
    const ranked = keys.map((k) => ({ key: k, score: smoothScores[k.id] }))
      .sort((a, b) => b.score - a.score).slice(0, 3);
    idFrozen = true;
    renderIdResults(ranked);
    $("#idRetryBtn").hidden = false;
  } finally {
    btn.disabled = false;
    btn.hidden = true; // file mode: hide capture until retry
    btn.innerHTML = "📸 Capture &amp; Identify";
  }
});

// Freeze the live ranking into a calm review state (stops re-ordering).
function freezeIdResults() {
  idFrozen = true;
  stopIdLoop();
  hideScanPaused();
  $("#idCaptureBtn").hidden = true;
  $("#idRetryBtn").hidden = false;
  $("#idGuideText").textContent = "Locked — tap the correct key, or scan again";
}

// Retry: clear the freeze and resume live scanning.
on("#idRetryBtn", "click", () => {
  const c = cams.id;
  $("#idRetryBtn").hidden = true;
  if (c && !c.usesFile) {
    startIdLoop();
  } else {
    // file fallback: just re-enable capture
    idFrozen = false;
    $("#idResults").innerHTML = "";
    $("#idCaptureBtn").hidden = false;
    $("#idGuideText").textContent = "Tap Capture to identify a key";
  }
});

function renderIdResults(ranked) {
  const box = $("#idResults");
  const guide = $("#idGuideText");
  let html = "";
  if (!ranked.length) {
    guide.textContent = "No keys stored yet — add one below";
    html = '<h3>No keys stored yet</h3><p class="hint">Add this key so Key Buddy can recognize it next time.</p>';
  } else {
    const top = Math.round(ranked[0].score * 100);
    const topName = isUnidentified(ranked[0].key) ? "Unidentified key" : ranked[0].key.for;
    if (idFrozen) {
      guide.textContent = `Locked on "${topName}" (${top}%) — or Scan again`;
    } else if (ranked[0].score >= 0.55) {
      guide.textContent = `Best: ${topName} (${top}%) — Lock in to hold the list steady`;
    } else {
      guide.textContent = `Best guess ${top}% — hold steady, or Lock in`;
    }
    html = "<h3>Likely matches</h3>";
    ranked.forEach((r) => {
      const pct = Math.round(r.score * 100);
      const thumb = r.key.thumbnails?.[0] || "";
      const decom = r.key.status === "obsolete";
      // Opt-in learning caps at 5 *learned* snapshots (enrollment photos are unlimited).
      const learned = (r.key.fingerprints || []).filter((f) => f && f.source === "learn").length;
      const teachBtn = learned >= 5
        ? `<button class="teach-btn" disabled title="5 learned views already — enough">✓ trained</button>`
        : `<button class="teach-btn" data-id="${r.key.id}">＋ improve</button>`;
      html += `<div class="candidate" data-id="${r.key.id}">
        <img class="thumb" src="${thumb}" alt="" />
        <div style="flex:1">
          <div class="meta"><span class="name">${keyLabel(r.key)}</span>${decom ? ' <span class="badge obsolete">decommissioned</span>' : ""}</div>
          <div class="score-bar"><div style="width:${pct}%"></div></div>
          <div class="sub" style="font-size:12px;color:var(--muted);margin-top:4px">${pct}% match${r.key.category ? " · " + escapeHtml(r.key.category) : ""}${r.key.date ? " · " + r.key.date : ""}</div>
        </div>
        ${teachBtn}
      </div>`;
    });
  }
  html += `<button class="btn secondary" id="idAddNew" style="margin-top:6px">➕ None of these — add as new key</button>`;
  if (ranked.length) {
    html += `<p class="hint" style="font-size:12px;text-align:center;margin-top:8px">Tap <strong>＋ improve</strong> on the correct key to teach Key Buddy this view (optional).</p>`;
  }
  box.innerHTML = html;

  // Opt-in learning only — tapping a row does nothing destructive.
  $$("#idResults .teach-btn[data-id]").forEach((el) => {
    el.addEventListener("click", (e) => { e.stopPropagation(); teachKey(el.dataset.id); });
  });
  $("#idAddNew").addEventListener("click", () => beginAddFromCapture());
}

let pendingCapture = null;

// Opt-in: add the current probe as an extra reference fingerprint for a key,
// improving future matches. Explicit action, so no accidental poisoning.
async function teachKey(id) {
  const key = await getKey(id);
  if (!key) return;
  const probe = lastProbe;
  if (!probe) { toast("No captured image to learn from."); return; }
  key.fingerprints = key.fingerprints || [];
  const learned = key.fingerprints.filter((f) => f && f.source === "learn").length;
  if (learned >= 5) { toast("Enough learned views already (5)."); return; }
  // Tag this fingerprint as learned so it's counted separately from enrollment.
  key.fingerprints.push({ ...probe, source: "learn" });
  key.updatedAt = new Date().toISOString();
  await putKey(key);
  const newLearned = learned + 1;
  toast(`✓ Improved: ${key.for || "Unidentified key"} (${newLearned}/5 learned)`);
  const btn = $(`#idResults .teach-btn[data-id="${id}"]`);
  if (btn && newLearned >= 5) { btn.textContent = "✓ trained"; btn.disabled = true; }
}

function beginAddFromCapture() {
  // carry the most recent live frame into the Add view
  if (lastCanvas && lastProbe) {
    pendingCapture = { canvas: lastCanvas, probe: lastProbe };
  }
  showView("add");
  if (pendingCapture) {
    stagedPhotos = [{ canvas: pendingCapture.canvas, thumb: canvasToThumb(pendingCapture.canvas), fp: pendingCapture.probe }];
    renderStagedThumbs();
    toast("Photo carried over — just add a label.");
  }
}

/* ---------- FIND IN PILE flow ---------- */
let findTargetKey = null;   // the key we're hunting for
const FIND_MATCH_THRESH = 0.52; // score above which a blob counts as a match

// Launch Find for a given stored key (called from My Keys).
async function startFindInPile(id) {
  findTargetKey = await getKey(id);
  if (!findTargetKey) return;
  $("#findTitle").textContent = "Find in pile";
  $("#findTarget").innerHTML = `Looking for: <strong>${keyLabel(findTargetKey)}</strong>${findTargetKey.category ? " · " + escapeHtml(findTargetKey.category) : ""}`;
  // reset UI
  $("#findResults").innerHTML = "";
  $("#findOverlay").hidden = true; $("#findOverlay").innerHTML = "";
  $("#findPreview").hidden = true; $("#findVideo").hidden = false;
  $("#findGuide").style.display = ""; $("#findRetryBtn").hidden = true;
  $("#findCaptureBtn").hidden = false;
  showView("find");
}

on("#findRetryBtn", "click", () => {
  $("#findResults").innerHTML = "";
  $("#findOverlay").hidden = true; $("#findOverlay").innerHTML = "";
  $("#findPreview").hidden = true; $("#findVideo").hidden = false;
  $("#findGuide").style.display = ""; $("#findRetryBtn").hidden = true;
  $("#findCaptureBtn").hidden = false;
});

on("#findCaptureBtn", "click", async () => {
  if (!findTargetKey) { toast("Pick a key from My Keys first."); return; }
  const btn = $("#findCaptureBtn");
  // grab a full (non-cropped) frame from the live camera, or file fallback
  const full = await captureFull("find");
  if (!full) return;

  // freeze the photo as the preview
  const prev = $("#findPreview");
  prev.width = full.width; prev.height = full.height;
  prev.getContext("2d").drawImage(full, 0, 0);
  prev.hidden = false; $("#findVideo").hidden = true; $("#findGuide").style.display = "none";
  $("#findRetryBtn").hidden = false; $("#findCaptureBtn").hidden = true;

  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Searching…';
  try {
    const seg = segmentPile(full, full.width, full.height);
    if (!seg.blobs.length) {
      renderFindResults([], seg);
      return;
    }
    // fingerprint each blob and score against the target key
    const scored = [];
    for (const b of seg.blobs) {
      const fp = await fingerprint(cropBlob(seg.canvas, b), false);
      scored.push({ blob: b, score: keyScore(fp, findTargetKey) });
    }
    renderFindResults(scored, seg);
  } finally {
    btn.disabled = false; btn.innerHTML = "📸 Capture &amp; find";
  }
});

function renderFindResults(scored, seg) {
  const matches = scored.filter((s) => s.score >= FIND_MATCH_THRESH)
    .sort((a, b) => b.score - a.score);
  // draw overlay boxes in the preview's coordinate space (viewBox 0..100)
  const ov = $("#findOverlay");
  ov.setAttribute("viewBox", `0 0 ${seg.W} ${seg.H}`);
  // "meet" letterboxes exactly like the preview's object-fit: contain, so boxes line up.
  ov.setAttribute("preserveAspectRatio", "xMidYMid meet");
  let svg = "";
  scored.forEach((s) => {
    const isMatch = s.score >= FIND_MATCH_THRESH;
    svg += `<rect class="${isMatch ? "match" : "other"}" x="${s.blob.x}" y="${s.blob.y}" width="${s.blob.w}" height="${s.blob.h}" rx="3"/>`;
    if (isMatch) {
      svg += `<text x="${s.blob.x + 1}" y="${Math.max(4, s.blob.y - 1)}">${Math.round(s.score * 100)}%</text>`;
    }
  });
  ov.innerHTML = svg;
  ov.hidden = false;

  const box = $("#findResults");
  if (!matches.length) {
    box.innerHTML = `<div class="empty">No match found in this photo.<br><span style="font-size:12px">Detected ${scored.length} key-like shape(s). Try spreading the keys apart on a plainer surface, or take a clearer photo.</span></div>`;
    return;
  }
  const word = matches.length === 1 ? "match" : "matches";
  box.innerHTML = `<h3>${matches.length} ${word} highlighted</h3>` +
    `<p class="hint">Green boxes mark where <strong>${keyLabel(findTargetKey)}</strong> appears${matches.length > 1 ? " (duplicates found)" : ""}. Other detected keys are outlined faintly.</p>`;
}

/* ---------- custom inline date picker (commits on tap) ---------- */
const DOW = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
let dpYear, dpMonth; // currently displayed month

function pad2(n) { return String(n).padStart(2, "0"); }
// Parse "YYYY-MM-DD" into parts without timezone drift.
function parseISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  return m ? { y: +m[1], mo: +m[2] - 1, d: +m[3] } : null;
}
function todayISO() {
  const n = new Date();
  return `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`;
}
// Set the date value; iso "" clears it. Defaults are applied by the caller.
function setDate(iso) {
  $("#addDate").value = iso || "";
  const p = parseISO(iso);
  if (p) { dpYear = p.y; dpMonth = p.mo; }
  updateDateSummary();
  renderDatePicker();
}
// The collapsed one-line summary shown until the field is clicked.
function updateDateSummary() {
  const btn = $("#addDateSummary");
  if (!btn) return;
  const p = parseISO($("#addDate").value);
  btn.innerHTML = p
    ? `<span>${MONTHS[p.mo]} ${p.d}, ${p.y}</span><span class="dp-clear" id="dpClear">clear</span>`
    : `<span style="color:var(--muted)">No date set</span>`;
  const clr = $("#dpClear");
  if (clr) clr.onclick = (e) => { e.stopPropagation(); setDate(""); };
}
function toggleDatePicker(force) {
  const host = $("#addDatePick");
  const btn = $("#addDateSummary");
  const open = force !== undefined ? force : host.hidden;
  host.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) renderDatePicker();
}
function renderDatePicker() {
  const host = $("#addDatePick");
  if (!host) return;
  if (dpYear == null) {
    const p = parseISO($("#addDate").value);
    const now = new Date();
    dpYear = p ? p.y : now.getFullYear();
    dpMonth = p ? p.mo : now.getMonth();
  }
  const sel = parseISO($("#addDate").value);
  const first = new Date(Date.UTC(dpYear, dpMonth, 1)).getUTCDay();
  const days = new Date(Date.UTC(dpYear, dpMonth + 1, 0)).getUTCDate();
  let cells = "";
  for (let i = 0; i < first; i++) cells += `<div class="dp-day empty"></div>`;
  for (let d = 1; d <= days; d++) {
    const isSel = sel && sel.y === dpYear && sel.mo === dpMonth && sel.d === d;
    cells += `<div class="dp-day${isSel ? " sel" : ""}" data-d="${d}">${d}</div>`;
  }
  host.innerHTML = `
    <div class="dp-head">
      <button type="button" id="dpPrev">‹</button>
      <span class="dp-title">${MONTHS[dpMonth]} ${dpYear}</span>
      <button type="button" id="dpNext">›</button>
    </div>
    <div class="dp-grid">${DOW.map((d) => `<div class="dp-dow">${d}</div>`).join("")}${cells}</div>`;
  $("#dpPrev").onclick = () => { dpMonth--; if (dpMonth < 0) { dpMonth = 11; dpYear--; } renderDatePicker(); };
  $("#dpNext").onclick = () => { dpMonth++; if (dpMonth > 11) { dpMonth = 0; dpYear++; } renderDatePicker(); };
  $$("#addDatePick .dp-day[data-d]").forEach((el) =>
    el.addEventListener("click", () => {
      setDate(`${dpYear}-${pad2(dpMonth + 1)}-${pad2(+el.dataset.d)}`);
      toggleDatePicker(false); // collapse after picking
    }));
}
// Clicking the collapsed summary opens the calendar; if no date is set yet,
// default the selection to today so the highlighted day "looks selected".
on("#addDateSummary", "click", () => {
  const willOpen = $("#addDatePick").hidden;
  if (willOpen && !$("#addDate").value) setDate(todayISO());
  toggleDatePicker();
});

/* ---------- category autocomplete ---------- */
async function refreshCategoryList() {
  const all = await getAllKeys();
  const cats = distinctCategories(all);
  $("#categoryList").innerHTML = cats.map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");
}

/* ---------- locations (multi-value chips per key) ---------- */
let stagedLocations = []; // array of location strings for the key being edited/added

function distinctLocations(keys) {
  const set = new Set();
  keys.forEach((k) => (k.locations || []).forEach((l) => l && set.add(l)));
  return [...set].sort((a, b) => a.localeCompare(b));
}
async function refreshLocationList() {
  const all = await getAllKeys();
  $("#locationList").innerHTML = distinctLocations(all)
    .map((l) => `<option value="${escapeHtml(l)}"></option>`).join("");
}
function renderLocationChips() {
  $("#addLocations").innerHTML = stagedLocations.map((l, i) =>
    `<span class="loc-chip">${escapeHtml(l)}<button type="button" data-i="${i}" aria-label="remove">×</button></span>`).join("");
  $$("#addLocations .loc-chip button").forEach((b) =>
    b.addEventListener("click", () => { stagedLocations.splice(+b.dataset.i, 1); renderLocationChips(); }));
}
function addLocationFromInput() {
  const inp = $("#addLocationInput");
  const val = inp.value.trim();
  if (!val) return;
  if (!stagedLocations.some((l) => l.toLowerCase() === val.toLowerCase())) {
    stagedLocations.push(val);
    renderLocationChips();
  }
  inp.value = "";
}
on("#addLocationInput", "keydown", (e) => {
  if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addLocationFromInput(); }
});
// Commit a location when the field loses focus or a datalist option is picked.
on("#addLocationInput", "change", addLocationFromInput);
on("#addLocationInput", "blur", addLocationFromInput);

/* ---------- ADD / EDIT flow ---------- */
let stagedPhotos = []; // {canvas, thumb, fp}
let editingId = null;

on("#addCaptureBtn", "click", async () => {
  const btn = $("#addCaptureBtn");
  const canvas = await capture("add");
  if (!canvas) return;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Processing…';
  try {
    const fp = await fingerprint(canvas);
    stagedPhotos.push({ canvas, thumb: canvasToThumb(canvas), fp });
    renderStagedThumbs();
  } finally {
    btn.disabled = false; btn.innerHTML = "📸 Add photo";
  }
});

function renderStagedThumbs() {
  const box = $("#addThumbs");
  box.innerHTML = stagedPhotos.map((p, i) =>
    `<div class="thumb" style="background-image:url('${p.thumb}');background-size:cover">
       <button class="thumb-del" data-i="${i}">×</button>
     </div>`).join("");
  $$("#addThumbs .thumb-del").forEach((b) =>
    b.addEventListener("click", () => { stagedPhotos.splice(+b.dataset.i, 1); renderStagedThumbs(); }));
}

on("#addSaveBtn", "click", async () => {
  const forVal = $("#addFor").value.trim();
  // "For" may be left blank — the key lands on the "to investigate" list.
  if (!stagedPhotos.length && !editingId) { toast("Add at least one photo."); return; }

  let key;
  if (editingId) {
    key = await getKey(editingId) || {};
  } else {
    key = { id: uid(), createdAt: new Date().toISOString(), fingerprints: [], thumbnails: [] };
  }
  addLocationFromInput(); // fold any half-typed location into the list
  key.for = forVal || null;
  key.category = $("#addCategory").value.trim() || null;
  key.locations = stagedLocations.slice();
  key.date = $("#addDate").value || null;
  key.status = $("#addStatus").value;
  key.notes = $("#addNotes").value.trim() || null;
  key.updatedAt = new Date().toISOString();
  key.createdAt = key.createdAt || key.updatedAt;
  // append newly staged photos
  key.fingerprints = key.fingerprints || [];
  key.thumbnails = key.thumbnails || [];
  for (const p of stagedPhotos) {
    key.fingerprints.push(p.fp);
    key.thumbnails.push(p.thumb);
  }
  await putKey(key);
  toast(editingId ? "✓ Updated" : "✓ Saved");
  resetAddForm();
  showView("keys");
});

on("#addCancelBtn", "click", () => { resetAddForm(); showView("keys"); });

function resetAddForm() {
  editingId = null;
  stagedPhotos = [];
  stagedLocations = [];
  pendingCapture = null;
  $("#addFor").value = ""; $("#addCategory").value = ""; $("#addNotes").value = "";
  $("#addLocationInput").value = "";
  renderLocationChips();
  setDate("");
  toggleDatePicker(false); // start collapsed
  $("#addStatus").value = "active";
  $("#addTitle").textContent = "Add a key";
  $("#addCancelBtn").hidden = true;
  renderStagedThumbs();
}

async function editKey(id) {
  const key = await getKey(id);
  if (!key) return;
  editingId = id;
  stagedPhotos = [];
  stagedLocations = (key.locations || []).slice();
  $("#addTitle").textContent = "Edit key";
  $("#addFor").value = key.for || "";
  $("#addCategory").value = key.category || "";
  $("#addLocationInput").value = "";
  renderLocationChips();
  setDate(key.date || "");
  toggleDatePicker(false); // collapsed until clicked
  $("#addStatus").value = key.status || "active";
  $("#addNotes").value = key.notes || "";
  $("#addCancelBtn").hidden = false;
  await refreshCategoryList();
  await refreshLocationList();
  renderStagedThumbs();
  // show existing thumbs (read-only reference)
  const box = $("#addThumbs");
  box.innerHTML = (key.thumbnails || []).map((t) =>
    `<div class="thumb" style="background-image:url('${t}');background-size:cover;opacity:.85"></div>`).join("")
    + '<div class="hint" style="width:100%;font-size:12px;margin-top:4px;color:var(--muted)">Existing photos (add more above to improve matching)</div>';
  showView("add");
}

/* ---------- MY KEYS ---------- */
// Filter is one of: "active", "obsolete" (Decommissioned), "all", or "cat:<name>".
let keysFilter = "active";

// Collect distinct, non-empty categories from stored keys.
function distinctCategories(keys) {
  const set = new Set();
  keys.forEach((k) => { if (k.category) set.add(k.category); });
  return [...set].sort((a, b) => a.localeCompare(b));
}

const isDecom = (k) => k.status === "obsolete";

async function renderFilterChips(all) {
  const inService = all.filter((k) => !isDecom(k));      // decommissioned excluded by default
  const cats = distinctCategories(inService);
  const count = (fn) => all.filter(fn).length;
  const unidentified = inService.filter(isUnidentified).length;
  const chips = [
    { f: "active", label: "Active", n: inService.length },
    // "To investigate" = in-service keys with no "For" yet.
    ...(unidentified ? [{ f: "unidentified", label: "To investigate", n: unidentified }] : []),
    // Category chips count only in-service keys (decommissioned are hidden unless explicitly requested).
    ...cats.map((c) => ({ f: "cat:" + c, label: c, n: inService.filter((k) => k.category === c).length })),
    { f: "obsolete", label: "Decommissioned", n: count(isDecom) },
    { f: "all", label: "All", n: all.length },
  ];
  const box = $("#keysFilters");
  box.innerHTML = chips.map((c) =>
    `<div class="chip ${keysFilter === c.f ? "active" : ""}" data-filter="${escapeHtml(c.f)}">${escapeHtml(c.label)}<span class="count">${c.n}</span></div>`
  ).join("");
  $$("#keysFilters .chip").forEach((el) =>
    el.addEventListener("click", () => { keysFilter = el.dataset.filter; renderKeys(); }));
}

function matchesFilter(k) {
  // "obsolete" and "all" are the only filters that reveal decommissioned keys.
  if (keysFilter === "obsolete") return isDecom(k);
  if (keysFilter === "all") return true;
  if (isDecom(k)) return false; // hidden from Active/category/unidentified by default
  if (keysFilter === "active") return true;
  if (keysFilter === "unidentified") return isUnidentified(k);
  if (keysFilter.startsWith("cat:")) return k.category === keysFilter.slice(4);
  return true;
}

async function renderKeys() {
  const all = await getAllKeys();
  await renderFilterChips(all);
  const list = all
    .filter(matchesFilter)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const box = $("#keysList");
  if (!list.length) {
    box.innerHTML = '<div class="empty">No keys here yet.</div>';
    return;
  }
  box.innerHTML = list.map((k) => `
    <div class="key-item">
      <img class="thumb" src="${k.thumbnails?.[0] || ""}" alt="" />
      <div class="meta">
        <div class="name">${keyLabel(k)}</div>
        <div class="sub">${isUnidentified(k) ? "🔎 needs identifying · " : ""}${k.category ? "🏷️ " + escapeHtml(k.category) + " · " : ""}${(k.locations && k.locations.length) ? "📍 " + k.locations.map(escapeHtml).join(", ") + " · " : ""}${k.date ? k.date + " · " : ""}${(k.fingerprints || []).length} photo(s)${k.notes ? " · " + escapeHtml(k.notes) : ""}</div>
      </div>
      <span class="badge ${k.status || "active"}">${k.status === "obsolete" ? "decommissioned" : (k.status || "active")}</span>
    </div>
    <div style="padding:0 12px 6px" data-id="${k.id}">
      <button class="btn find-btn" ${(k.fingerprints || []).length ? "" : "disabled"}>🔦 Find in pile</button>
    </div>
    <div class="row" style="padding:0 12px 12px" data-id="${k.id}">
      <button class="btn secondary edit-btn">Edit</button>
      <button class="btn secondary toggle-btn">${(k.status === "obsolete") ? "Reactivate" : "Decommission"}</button>
      <button class="btn danger del-btn">Delete</button>
    </div>
  `).join("");
  $$("#keysList .find-btn").forEach((b) =>
    b.addEventListener("click", () => startFindInPile(b.closest("[data-id]").dataset.id)));
  $$("#keysList .edit-btn").forEach((b) =>
    b.addEventListener("click", () => editKey(b.closest("[data-id]").dataset.id)));
  $$("#keysList .toggle-btn").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = b.closest("[data-id]").dataset.id;
      const k = await getKey(id); if (!k) return;
      k.status = (k.status === "obsolete") ? "active" : "obsolete";
      k.updatedAt = new Date().toISOString();
      await putKey(k); renderKeys();
      toast(k.status === "obsolete" ? "Decommissioned" : "Reactivated");
    }));
  $$("#keysList .del-btn").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = b.closest("[data-id]").dataset.id;
      if (!confirm("Delete this key permanently?")) return;
      await deleteKey(id); renderKeys(); toast("Deleted");
    }));
}

/* ---------- SYNC ---------- */
on("#exportBtn", "click", async () => {
  const keys = await getAllKeys();
  const payload = { app: "keybuddy", version: 1, exportedAt: new Date().toISOString(), keys };
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const stamp = new Date().toISOString().slice(0, 10);
  const fname = `keybuddy-${stamp}.json`;
  const file = new File([blob], fname, { type: "application/json" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "Key Buddy export" }); return; } catch (_) {}
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = fname; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${keys.length} key(s)`);
});

// Export a labeled training dataset: one record per photo with its label,
// category, status, and the stored image (data URL). Useful for training a
// custom key model later. Images are the stored thumbnails.
on("#exportTrainBtn", "click", async () => {
  const keys = await getAllKeys();
  const samples = [];
  keys.forEach((k) => {
    (k.thumbnails || []).forEach((img, i) => {
      samples.push({
        keyId: k.id,
        label: k.for || null,
        category: k.category || null,
        status: k.status || "active",
        image: img,
      });
    });
  });
  if (!samples.length) { toast("No labeled photos to export yet."); return; }
  const payload = {
    app: "keybuddy-training", version: 1,
    exportedAt: new Date().toISOString(),
    note: "Each sample: {label, category, status, image(dataURL)}. Images are stored thumbnails.",
    count: samples.length, samples,
  };
  const stamp = new Date().toISOString().slice(0, 10);
  downloadJSON(payload, `keybuddy-training-${stamp}.json`);
  toast(`Exported ${samples.length} labeled photo(s)`);
});

// Shared: share-or-download a JSON payload as a file.
async function downloadJSON(payload, fname) {
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const file = new File([blob], fname, { type: "application/json" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: fname }); return; } catch (_) {}
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = fname; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

on("#importBtn", "click", () => $("#importInput").click());
on("#importInput", "change", async () => {
  const f = $("#importInput").files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== "keybuddy" || !Array.isArray(data.keys)) throw new Error("bad file");
    let added = 0, updated = 0;
    for (const incoming of data.keys) {
      if (!incoming.id) continue;
      const existing = await getKey(incoming.id);
      if (!existing) { await putKey(incoming); added++; }
      else {
        // newest updatedAt wins
        const a = existing.updatedAt || existing.createdAt || "";
        const b = incoming.updatedAt || incoming.createdAt || "";
        if (b > a) { await putKey(incoming); updated++; }
      }
    }
    toast(`Imported: ${added} new, ${updated} updated`);
    renderStats();
  } catch (e) {
    console.error(e);
    toast("Import failed — not a valid Key Buddy file.");
  }
  $("#importInput").value = "";
});

on("#resetBtn", "click", async () => {
  if (!confirm("Delete ALL keys on this device? This cannot be undone.")) return;
  const all = await getAllKeys();
  for (const k of all) await deleteKey(k.id);
  toast("All data cleared");
  renderStats();
});

async function renderStats() {
  const all = await getAllKeys();
  const active = all.filter((k) => (k.status || "active") === "active").length;
  $("#statsLine").textContent = `${all.length} key(s) on this device · ${active} active · ${all.length - active} decommissioned`;
}

// Load a stored thumbnail (data URL) into a CAP-square work canvas for re-fingerprinting.
function dataUrlToWorkCanvas(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(toWorkCanvas(img, img.naturalWidth, img.naturalHeight));
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// Rebuild every key's fingerprints FROM its stored photos. Confirmation-added
// fingerprints have no matching photo, so they simply vanish; enrollment photos
// are re-fingerprinted with the current pipeline.
on("#rebuildBtn", "click", async () => {
  const all = await getAllKeys();
  if (!all.length) { toast("No keys to rebuild."); return; }
  if (!confirm("Rebuild fingerprints for all keys from their photos? This removes stray confirmation images and cannot be undone.")) return;
  const btn = $("#rebuildBtn");
  btn.disabled = true;
  const status = $("#rebuildStatus");
  // Wait (briefly) for OpenCV so rebuilt fingerprints get consistent background masking.
  ensureOpenCV();
  if (!cvReady) {
    status.textContent = "Preparing image tools…";
    for (let i = 0; i < 60 && !cvReady; i++) await new Promise((r) => setTimeout(r, 250));
  }
  let done = 0, removed = 0, keysTouched = 0;
  for (const key of all) {
    const thumbs = key.thumbnails || [];
    const before = (key.fingerprints || []).length;
    const rebuilt = [];
    for (const t of thumbs) {
      const canvas = await dataUrlToWorkCanvas(t);
      if (!canvas) continue;
      const fp = await fingerprint(canvas);
      rebuilt.push(fp);
    }
    removed += Math.max(0, before - rebuilt.length);
    if (before !== rebuilt.length) keysTouched++;
    key.fingerprints = rebuilt;
    key.updatedAt = new Date().toISOString();
    await putKey(key);
    done++;
    status.textContent = `Rebuilding… ${done}/${all.length} keys`;
  }
  status.textContent = `Done — ${done} keys rebuilt, ${removed} stray fingerprint(s) removed.`;
  toast(`✓ Rebuilt ${done} keys · removed ${removed} stray`);
  btn.disabled = false;
});

/* ---------- util ---------- */
const isUnidentified = (k) => !k.for || !String(k.for).trim();
// Human label for a key, escaped for HTML. Unidentified keys get a placeholder.
function keyLabel(k) {
  return isUnidentified(k)
    ? '<span style="font-style:italic;color:var(--muted)">Unidentified key</span>'
    : escapeHtml(k.for);
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- service worker (offline) ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

/* ---------- boot ---------- */
// Wrap boot so any unexpected error surfaces to the user instead of leaving
// the app frozen on the static "starting…" default.
try {
  setDate("");            // initialize the date picker to "no date"
  toggleDatePicker(false); // start collapsed
  renderLocationChips();
  // Default to My Keys (not Identify) so the camera/scan loop don't start on launch — saves battery.
  showView("keys");
} catch (e) {
  console.error("Key Buddy boot error:", e);
  const lbl = $("#modelLabel");
  if (lbl) lbl.textContent = "load error — pull to refresh";
}
loadModel();
