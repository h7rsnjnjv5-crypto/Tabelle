# Drink Tracker

Track and rate alcoholic drinks. Plain HTML/CSS/JS, no build step, no backend.
All data (including photos) is stored locally in the browser's IndexedDB.

## Use it
- **Desktop:** open `index.html` in a browser, or serve the folder (`python3 -m http.server`).
- **Phone:** host the folder anywhere static (e.g. GitHub Pages) and open it in the phone's browser.
  "Take photo" opens the camera; "Choose image" opens the gallery.

Data lives only in that browser on that device. Use **Settings → Export JSON** regularly as a backup;
**Import JSON** restores a backup (it replaces the current data).

## Save to GitHub (optional)
Settings → **Save to GitHub** saves every new, edited or deleted entry automatically to a GitHub repository.
1. Create a fine-grained token at https://github.com/settings/personal-access-tokens/new
   — *Only select repositories* → your repo, *Permissions → Contents: Read and write*.
2. In the app enter the repository (`owner/name`), keep branch `data`, paste the token, tap **Save & connect**.

Files on the `data` branch: `drinks/<id>.json`, `photos/<id>.jpg`, `config.json` (tabs + currency).
Changes made offline are queued and uploaded later (status line under the title).
On another device, connect with the same settings to load the data from GitHub.
**If the repository is public, the data and photos are public too** — use a private repository for private data.
The token is stored only on the device and is never included in exports.

## Files
- `index.html` – markup and dialogs
- `style.css` – styles (dark mode follows the system)
- `app.js` – storage, calculations, UI
- `test.js` – tests for the price math and validation: `node test.js`

## Calculations
- Price per liter = price ÷ volume in liters
- Price per liter of pure alcohol = price ÷ (volume in liters × ABV ÷ 100)
- Best value (highlighted in the current view) = highest rating ÷ price per liter
