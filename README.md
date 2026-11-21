# Drink Tracker

Track, rate and map alcoholic drinks. Plain HTML/CSS/vanilla JS, no build step, no backend.
All data (including photos) is stored locally in the browser's IndexedDB. iOS-style design,
installable as an app (PWA), dark mode follows the system.

## Run it

Camera access, "Add to Home Screen" (PWA) and offline mode need **HTTPS or localhost**.

**On your computer (testing):** serve the folder with any static server, then open http://localhost:8000
```sh
python3 -m http.server 8000      # or: npx serve .
```
(Opening `index.html` directly via `file://` works for basic use, but without the offline/PWA part.)

**On your phone (recommended): GitHub Pages** – free HTTPS hosting.
1. Repository → Settings → Pages → *Deploy from a branch* → pick the branch with these files, folder `/ (root)` → Save.
2. After a minute open `https://<user>.github.io/<repo>/` in Safari (iPhone) or Chrome (Android).
3. Share menu → **Add to Home Screen**. It now opens full-screen like an app and works offline
   (the map and AI need a connection).

Data lives in the browser of that device. Use **Settings → Export JSON** regularly as a backup;
**Import JSON** restores it (replaces the current data). Backups from older versions still import.

## Read label (free, on your phone)
After adding a photo, tap **Read label (free)**. Text recognition (Tesseract.js) runs on the device –
no account, no API key, no cost. The first use downloads about 7 MB (needs internet), after that it works offline.
- It fills only **ABV** (e.g. "12,5 % vol", "Alc. 40%") and **volume** (e.g. "0,75 l", "70cl", "330 ml"),
  and only when exactly one clear value is found. Other percentages like "100% Malt" are ignored.
- Name and producer are not guessed: the recognized text is shown so you can select and copy it.
- Only empty fields are filled and highlighted; nothing is saved until you tap Save.
- Works best with a sharp, close, straight photo of the label. Curved or stylised labels may be misread – then fields stay empty.

## Identify drinks with AI (optional, paid)
Take or choose a photo, then tap **Identify drink**. The photo is sent to the Anthropic API, which reads
the label and returns name, producer, category, ABV, volume, country, region and a short description.
- Values it cannot read are left empty – it is told never to guess, and the app re-checks every value.
- With *Web search* on (Settings), it may look up missing ABV/origin for a clearly identified product; sources are shown.
- Only **empty** fields are filled and highlighted; nothing is saved until you tap Save.
- Needs your own API key (Settings → *API key*, from https://console.anthropic.com). It is stored only on this
  device, never exported, and sent only to `api.anthropic.com`. Meant for personal use; usage is billed to your account.
- The model is set by `AI_MODEL` at the top of `app.js`.

## Map
Each drink can have a country and an optional region/city. The **Map** tab shows pins grouped by country
(blue) or region (orange) with a count; tap a pin to see its drinks. Country positions come from a built-in table
(works offline, English and German names). Regions are looked up once via OpenStreetMap Nominatim when you save,
and cached in the drink; if that fails, the pin falls back to the country.

## Save to GitHub (optional)
Settings → **Save to GitHub** saves every new, edited or deleted entry automatically to a GitHub repository.
1. Create a fine-grained token at https://github.com/settings/personal-access-tokens/new
   — *Only select repositories* → your repo, *Permissions → Contents: Read and write*.
2. In the app enter the repository (`owner/name`), keep branch `data`, paste the token, tap **Save & connect**.

Files on the `data` branch: `drinks/<id>.json`, `photos/<id>.jpg`, `config.json` (tabs + currency).
Changes made offline are queued and uploaded later (status next to the title).
**If the repository is public, the data and photos are public too** — use a private repository for private data.

## Files
- `index.html` – markup, views and sheets
- `style.css` – iOS-style styles (light + dark)
- `app.js` – storage, calculations, UI, AI, map, sync
- `sw.js`, `manifest.webmanifest`, `icons/` – PWA (offline app shell, home-screen icon)
- `test.js` – tests for calculations, validation, AI-answer checking, countries/map grouping: `node test.js`

## Calculations
- Price per liter = price ÷ volume in liters
- Price per liter of pure alcohol = price ÷ (volume in liters × ABV ÷ 100)
- Best value (highlighted in the current view) = highest rating ÷ price per liter
