# Apple SKP Viewer

A viewer for SketchUp (.skp) files that runs on an iPhone or iPad. No App Store, no Apple account, nothing to install.

**Open this on the device: https://itsleighton.github.io/apple-skp-viewer/**

Then put it on the home screen, so it opens like an app: tap the **Share** button in Safari, then **Add to Home Screen**. It gets an icon and opens full screen. Once it has been opened once, it works with no signal.

The same link works in Chrome on Android and on a desktop, if you ever need it to.

## Opening a model

Tap **Open file**, then **Browse**, and pick a .skp from iCloud Drive, Google Drive, Dropbox or wherever your files are.

You can't send a .skp to this from another app's Share menu — Apple doesn't allow a web app to appear there. Open the viewer first and pick the file from inside it.

## What it does

- Orbit with one finger, pan and pinch zoom with two, double-tap to re-centre
- Walk / look-around mode with an on-screen joystick
- Standard views, perspective or parallel, zoom to fit
- Scenes from the file, with each scene's camera and hidden tags
- Tags panel and an outliner for groups and components
- Face styles: textured, shaded, monochrome, colour by tag, hidden line, X-ray, wireframe
- Tape measure that snaps to corners, with horizontal, vertical and slope
- Text labels and dimensions from the model
- A library of the models you've opened, kept on the device

## Your drawings stay on your device

There is no server behind this. Opening a model reads it on the phone and draws it there — nothing is uploaded. This repository holds only the viewer.

Very large models go further on Android than on an iPhone, which is stricter about memory. If one fails to open, a purged copy (Window → Model Info → Statistics → Purge Unused) usually works.

## Development

```
npm install
npm run dev      # http://localhost:5173
npm run build    # dist/, including the offline service worker
```

Pushing to `main` builds and publishes automatically — see `.github/workflows/pages.yml`.

- `src/main.js` — three.js viewer and UI
- `src/parse-worker.js` — reads a .skp off the main thread and turns it into render buffers
- `src/annotations.js` — reads text labels and dimensions, which OpenSKP parses but discards the positions of
- `src/db.js` — the on-device library
- `src/vendor/openskp.mjs` — [OpenSKP](https://github.com/iamahsanmehmood/openskp) 1.5.0 (MIT) with small local changes, marked in the file: extra exports, and a `definitionId` on scene nodes so a callout can be matched to the group that owns it
- `scripts/make-sw.mjs` — writes `dist/sw.js` so the app works offline

## Related

There is a separate Android app, kept in its own repository. The two are deliberately independent — nothing here builds or depends on it.

The .skp reader is [OpenSKP](https://github.com/iamahsanmehmood/openskp) (MIT), an open-source reverse-engineered reader. Not made or endorsed by Trimble.
