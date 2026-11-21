# Drink Tracker

Track and rate alcoholic drinks. Plain HTML/CSS/JS, no build step, no backend.
All data (including photos) is stored locally in the browser's IndexedDB.

## Use it
- **Desktop:** open `index.html` in a browser, or serve the folder (`python3 -m http.server`).
- **Phone:** host the folder anywhere static (e.g. GitHub Pages) and open it in the phone's browser.
  "Take photo" opens the camera; "Choose image" opens the gallery.

Data lives only in that browser on that device. Use **Settings → Export JSON** regularly as a backup;
**Import JSON** restores a backup (it replaces the current data).

## Files
- `index.html` – markup and dialogs
- `style.css` – styles (dark mode follows the system)
- `app.js` – storage, calculations, UI
- `test.js` – tests for the price math and validation: `node test.js`

## Calculations
- Price per liter = price ÷ volume in liters
- Price per liter of pure alcohol = price ÷ (volume in liters × ABV ÷ 100)
- Best value (highlighted in the current view) = highest rating ÷ price per liter
