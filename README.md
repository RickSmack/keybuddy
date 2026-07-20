# 🔑 Key Buddy

A phone-friendly web app that helps you **identify and organize physical keys** — building
doors, tractors, tools, padlocks, and anything else on your ring. Point your camera at a key,
and Key Buddy compares its visual "fingerprint" against the ones you've saved and tells you
what it's for.

Everything is stored **only on your device**. There is no server, no account, and no cloud.

---

## How it works (and its honest limits)

Key Buddy does **visual similarity matching**, not true key decoding. It captures a photo,
computes a fingerprint from it — a MobileNet image embedding plus a lightweight silhouette /
"bitting profile" shape descriptor and a perceptual hash — and ranks your stored keys by
similarity.

Because two similar keys (say, two house keys) can look almost identical, Key Buddy shows you
the **top few candidates and asks you to confirm** rather than guessing a single answer. For
best results:

- Lay the key **flat on a plain, contrasting surface**.
- Fill the on-screen dashed box with the key.
- Enroll each key with **2–3 photos** from slightly different angles — every confirmed match
  also strengthens that key's fingerprint over time.

---

## Using it

| Tab | What it does |
|-----|--------------|
| **Identify** | Point the camera at a key — matches appear live; tap one to confirm, or add as new. |
| **Add** | Snap photos, enter what the key is **For** (optional), plus **Category**, **Date**, and status. |
| **My Keys** | Browse/filter your inventory by status/category; edit, **decommission**, reactivate, or delete. |
| **Sync** | Export/import your keys, and reset all data. |
| **Settings** | Configure auto-scan (on/off) and how it auto-pauses to save battery. |

### Auto-identify and battery
By default the **Identify** screen scans the live camera continuously and updates the ranked
matches in real time — no button press. Because that uses more battery than a single capture,
it **auto-pauses** and shows a **Resume** button (tapping the camera also resumes). In
**Settings** you can:

- **Enable/disable auto-scan.** When off, Identify uses a manual **Capture** button instead.
- **Choose when it pauses:** after a period of **no motion** (default 10s), after a **fixed
  time** (default 25s), **either one** (whichever comes first), or **never**.
- **Tune both thresholds** with sliders.

### Categories
Give each key an optional **Category** — a free-form label for grouping, e.g. *"Bert's Keys"*,
*"Mom's Keys"*, *"Barn"*. **My Keys** shows a filter chip per category (with counts). The
category box autocompletes from categories you've already used.

### Unidentified keys ("to investigate")
You don't have to know what a key is for when you add it — **leave the "For" field blank** and
it's saved as an *Unidentified key*. These collect under a **To investigate** filter in
**My Keys** so you have a running list to work through. When you figure one out, open it, fill
in the "For", and save. They're still fingerprinted, so scanning an unknown key can match one
you already captured.

### Decommissioning keys
When a lock or tool is replaced, open the key in **My Keys** and tap **Decommission** (the
optional **Date** helps you review old keys). Decommissioned keys are:

- **Still identifiable** — a key you pick up may be one you previously decommissioned, so it
  still shows up when scanning (flagged with a *decommissioned* badge in the results).
- **Hidden from listings by default** — the **Active** chip and every category chip exclude
  them; only the **Decommissioned** and **All** chips reveal them.

You can **Reactivate** a key at any time.

---

## Syncing with another phone (e.g. your spouse)

There's no server, so sync is a manual file exchange:

1. On phone A: **Sync → Export keys to file** (uses the native share sheet if available, or
   downloads a `keybuddy-YYYY-MM-DD.json` file).
2. Send that file to phone B (AirDrop, text, email, etc.).
3. On phone B: **Sync → Import keys from file** and pick it.

Import **merges** by key; on conflicts the **most recently edited** version wins. Run it both
directions to converge two inventories.

---

## Sharing a blank copy

The app file contains **no key data** — all keys live in the browser's local database on each
device. So sharing a blank copy is automatic: just send someone the Key Buddy **link** (or the
files). They'll open it to an empty inventory. (An in-app **Reset all data** button is also
provided if you ever want to wipe your own device.)

---

## Deploying (GitHub Pages)

Live camera preview requires HTTPS (a "secure context"). The easiest free host is GitHub Pages:

1. Create a repository and add `index.html` and `sw.js` (and this `README.md`).
2. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   pick your branch and the `/ (root)` folder, and save.
3. Open the published `https://<you>.github.io/<repo>/` URL on your phone.
4. On first load (while online) the ML libraries download and are cached by the service worker;
   afterward the app works **offline**.

> Tip: On iPhone/Android, use your browser's **"Add to Home Screen"** to launch it like an app.

### Running locally for testing
Camera needs a secure context, and `localhost` counts as one. From this folder:

```bash
# Python 3
python -m http.server 8000
# then open http://localhost:8000 on the same machine
```

For testing on a phone against your dev machine you'll need HTTPS (e.g. a tunneling tool) since
plain `http://<lan-ip>` is not a secure context.

---

## Privacy

- Photos, fingerprints, and labels never leave your device except through the export file **you**
  choose to share.
- No analytics, no network calls except loading the ML libraries (once, then cached).

## Files

- `index.html` — the entire app (UI + logic, inline).
- `sw.js` — service worker for offline caching.
- `README.md` — this file.
