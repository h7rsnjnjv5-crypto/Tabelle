/* Drink Tracker – vanilla JS, all data stored locally in IndexedDB. */
'use strict';

/** Claude model used for "Identify drink". Change it here. */
const AI_MODEL = 'claude-opus-5-5';
const AI_TIMEOUT_MS = 120000;
const LEAFLET_URL = 'https://unpkg.com/leaflet@1.9.4/dist/';
/** Free on-device label reading (Tesseract.js). Downloaded once (~7 MB), then cached. */
const OCR = {
  script: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
  workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
  corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1',
  langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
};

/* =====================================================================
   Pure helpers (no DOM). Also loaded by test.js under Node.
   ===================================================================== */

/** Parse a user-entered number. Accepts "12,99" and "12.99".
 *  Returns null for empty input and NaN for anything that is not a number. */
function parseNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const s = String(value).trim().replace(',', '.');
  if (s === '') return null;
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  return Number(s);
}

/** Round to cents, avoiding binary float surprises like 1.005 -> 1.00. */
function roundMoney(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Volume in liters, or null if missing/zero. */
function toLiters(volume, unit) {
  if (!(typeof volume === 'number' && volume > 0)) return null;
  return unit === 'l' ? volume : volume / 1000;
}

/** Price per liter and per liter of pure alcohol. Returns null where not computable (never NaN). */
function calcPrices(price, volume, unit, abv) {
  const liters = toLiters(volume, unit);
  const hasPrice = typeof price === 'number' && Number.isFinite(price) && price >= 0;
  const perLiter = hasPrice && liters ? price / liters : null;
  const validAbv = typeof abv === 'number' && abv > 0 && abv <= 100;
  const perAlcoholLiter = hasPrice && liters && validAbv ? price / (liters * abv / 100) : null;
  return { perLiter, perAlcoholLiter };
}

/** Validate raw form values (strings). Returns { errors, values }. */
function validateDrink(f) {
  const errors = {};
  const name = String(f.name || '').trim();
  if (!name) errors.name = 'Name is required.';
  if (!f.tabId) errors.tabId = 'Choose a category.';

  const rating = Number(f.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 10) errors.rating = 'Pick a rating from 1 to 10.';

  const price = parseNumber(f.price);
  if (Number.isNaN(price)) errors.price = 'Enter a valid number.';
  else if (price !== null && price < 0) errors.price = 'Price cannot be negative.';

  const volume = parseNumber(f.volume);
  if (Number.isNaN(volume)) errors.volume = 'Enter a valid number.';
  else if (volume !== null && volume <= 0) errors.volume = 'Volume must be greater than 0.';

  const abv = parseNumber(f.abv);
  if (Number.isNaN(abv)) errors.abv = 'Enter a valid number.';
  else if (abv !== null && (abv < 0 || abv > 100)) errors.abv = 'ABV must be between 0 and 100.';

  return {
    errors,
    values: {
      name,
      tabId: f.tabId,
      brand: String(f.brand || '').trim(),
      notes: String(f.notes || '').trim(),
      rating,
      price: price === null || Number.isNaN(price) ? null : roundMoney(price),
      volume: Number.isNaN(volume) ? null : volume,
      volumeUnit: f.volumeUnit === 'l' ? 'l' : 'ml',
      abv: Number.isNaN(abv) ? null : abv,
      country: cleanText(f.country, 80),
      region: cleanText(f.region, 80),
    },
  };
}

/** Trimmed, length-limited text, or null when empty. */
function cleanText(v, max) {
  const s = typeof v === 'string' ? v.trim().slice(0, max) : '';
  return s || null;
}

/** Filter + sort drinks. Each returned row = drink + computed perLiter/perAlcoholLiter. */
function applyView(drinks, opts) {
  const search = (opts.search || '').trim().toLowerCase();
  let rows = drinks.map((d) => Object.assign({}, d, calcPrices(d.price, d.volume, d.volumeUnit, d.abv)));
  rows = rows.filter((d) =>
    (opts.tabId === 'all' || d.tabId === opts.tabId) &&
    (!search || d.name.toLowerCase().includes(search)) &&
    (!opts.minRating || d.rating >= opts.minRating) &&
    (opts.maxPerLiter === null || opts.maxPerLiter === undefined ||
      (d.perLiter !== null && d.perLiter <= opts.maxPerLiter)));

  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  // Missing values always go last.
  const asc = (key) => (a, b) => {
    if (a[key] === null && b[key] === null) return byName(a, b);
    if (a[key] === null) return 1;
    if (b[key] === null) return -1;
    return a[key] - b[key] || byName(a, b);
  };
  const sorters = {
    rating: (a, b) => b.rating - a.rating || byName(a, b),
    perLiter: asc('perLiter'),
    perAlcoholLiter: asc('perAlcoholLiter'),
    date: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    name: byName,
  };
  return rows.sort(sorters[opts.sort] || sorters.date);
}

/** "Best value" = highest rating per unit of price per liter. Returns drink id or null. */
function pickBestValue(rows) {
  let best = null;
  let bestScore = -1;
  for (const d of rows) {
    if (!(d.perLiter > 0) || !d.rating) continue;
    const score = d.rating / d.perLiter;
    if (score > bestScore || (score === bestScore && d.rating > best.rating)) {
      best = d;
      bestScore = score;
    }
  }
  return best ? best.id : null;
}

/** Check a tab name. Returns an error message or null. */
function validateTabName(name, tabs, excludeId) {
  const n = String(name || '').trim();
  if (!n) return 'Tab name cannot be empty.';
  if (n.length > 30) return 'Tab name is too long (max 30).';
  if (n.toLowerCase() === 'all') return '“All” is reserved.';
  if (tabs.some((t) => t.id !== excludeId && t.name.toLowerCase() === n.toLowerCase())) return 'A tab with this name already exists.';
  return null;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

const DEFAULT_TABS = ['Wine', 'Beer', 'Liqueur', 'Spirits', 'Other'];

function defaultTabs() {
  return DEFAULT_TABS.map((name, i) => ({ id: uid(), name, order: i }));
}

/** Tab that receives orphaned drinks: "Other" if present, else the last tab. */
function fallbackTabId(tabs) {
  const other = tabs.find((t) => t.name.toLowerCase() === 'other');
  return (other || tabs[tabs.length - 1]).id;
}

/** Validate and normalise an imported backup object. Throws on bad data.
 *  Photos stay as data-URL strings here; the browser converts them to Blobs. */
function parseBackup(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.tabs) || !Array.isArray(data.drinks)) {
    throw new Error('This file is not a Drink Tracker backup.');
  }
  const tabs = [];
  data.tabs.forEach((t, i) => {
    if (!t || typeof t.id !== 'string' || validateTabName(t.name, tabs)) return; // skip invalid/duplicate tabs
    tabs.push({ id: t.id, name: String(t.name).trim(), order: Number.isFinite(t.order) ? t.order : i });
  });
  if (tabs.length === 0) tabs.push(...defaultTabs());
  tabs.sort((a, b) => a.order - b.order);
  const tabIds = new Set(tabs.map((t) => t.id));

  const drinks = data.drinks.map((d, i) => {
    if (!d || typeof d !== 'object') throw new Error(`Drink #${i + 1} is not valid.`);
    const tabId = tabIds.has(d.tabId) ? d.tabId : fallbackTabId(tabs);
    const raw = {
      name: d.name, tabId, brand: d.brand, notes: d.notes, rating: d.rating,
      price: d.price === null || d.price === undefined ? '' : String(d.price),
      volume: d.volume === null || d.volume === undefined ? '' : String(d.volume),
      abv: d.abv === null || d.abv === undefined ? '' : String(d.abv),
      volumeUnit: d.volumeUnit,
      country: d.country,
      region: d.region,
    };
    const { errors, values } = validateDrink(raw);
    const keys = Object.keys(errors);
    if (keys.length) throw new Error(`Drink #${i + 1} (“${d.name || '?'}”): ${errors[keys[0]]}`);
    const isImg = (s) => (typeof s === 'string' && s.startsWith('data:image/')) ||
      (typeof Blob !== 'undefined' && s instanceof Blob);
    return Object.assign(values, {
      id: typeof d.id === 'string' && d.id ? d.id : uid(),
      photo: isImg(d.photo) ? d.photo : null,
      thumb: isImg(d.thumb) ? d.thumb : (isImg(d.photo) ? d.photo : null),
      createdAt: Number.isFinite(d.createdAt) ? d.createdAt : Date.now(),
      updatedAt: Number.isFinite(d.updatedAt) ? d.updatedAt : Date.now(),
      // Cached geocoding result (only kept if it looks valid)
      lat: validLatLng(d.lat, d.lng) ? d.lat : null,
      lng: validLatLng(d.lat, d.lng) ? d.lng : null,
      geoQuery: validLatLng(d.lat, d.lng) && typeof d.geoQuery === 'string' ? d.geoQuery : null,
    });
  });

  const currency = data.settings && typeof data.settings.currency === 'string' && data.settings.currency.trim()
    ? data.settings.currency.trim().slice(0, 5) : '€';
  return { tabs, drinks, settings: { currency } };
}

function validLatLng(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/* =====================================================================
   IndexedDB layer
   ===================================================================== */

const DB_NAME = 'drink-tracker';
const DB_VERSION = 2; // v2: origin fields (country, region, lat, lng, geoQuery)
let db = null;

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('IndexedDB is not available in this browser.'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = req.result;
      if (!d.objectStoreNames.contains('tabs')) d.createObjectStore('tabs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('drinks')) d.createObjectStore('drinks', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      if (e.oldVersion >= 1 && e.oldVersion < 2) {
        // Add the new origin fields to existing drinks; nothing else changes.
        req.transaction.objectStore('drinks').openCursor().onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (!cursor) return;
          cursor.update(withOriginFields(cursor.value));
          cursor.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database is blocked by another open tab. Close other tabs and reload.'));
  });
}

/** Make sure a drink record has all v2 fields. */
function withOriginFields(d) {
  ['country', 'region', 'lat', 'lng', 'geoQuery'].forEach((k) => { if (d[k] === undefined) d[k] = null; });
  return d;
}

/** Resolves when a transaction has committed. */
function txDone(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted.'));
  });
}

function getAll(store) {
  return new Promise((resolve, reject) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function putAll(store, items) {
  const t = db.transaction(store, 'readwrite');
  items.forEach((item) => t.objectStore(store).put(item));
  return txDone(t);
}

function deleteKey(store, key) {
  const t = db.transaction(store, 'readwrite');
  t.objectStore(store).delete(key);
  return txDone(t);
}

/* =====================================================================
   Images
   ===================================================================== */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image.'));
    img.src = src;
  });
}

/** Downscale an image Blob so its longest side is <= maxSize; returns a JPEG Blob. */
async function resizeImage(blob, maxSize, quality) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // flatten transparency for JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image.'))), 'image/jpeg', quality));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = (head.match(/^data:([^;]+)/) || [])[1] || 'image/jpeg';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/* =====================================================================
   UI
   ===================================================================== */

const ALL = 'all';
const state = {
  tabs: [],
  drinks: [],
  settings: { currency: '€' },
  tab: ALL,
  editingId: null,
  formPhoto: null, // Blob of the photo currently in the form
  formThumb: null,
  deletingTabId: null,
  view: 'drinks',
  mapTab: ALL,
  categoryTouched: false,
};
const thumbUrls = new Map(); // drink id -> { blob, url } for list thumbnails
let previewUrl = null;
let viewerUrl = null;

const $ = (sel) => document.querySelector(sel);
const NUM2 = typeof Intl !== 'undefined'
  ? new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null;
const NUM = typeof Intl !== 'undefined' ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }) : null;

function money(n) {
  return typeof n === 'number' && Number.isFinite(n) ? `${NUM2.format(n)} ${state.settings.currency}` : '–';
}

/** Tiny DOM builder; children are appended as text, never as HTML. */
function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return n;
}

function tabName(id) {
  const t = state.tabs.find((x) => x.id === id);
  return t ? t.name : '?';
}

/* ---------- Startup ---------- */

async function init() {
  try {
    db = await openDb();
    await loadAll();
    await loadSyncConfig();
    await loadAiConfig();
  } catch (err) {
    document.body.prepend(el('p', { class: 'err' }, 'Could not open local storage: ' + err.message));
    return;
  }
  // Ask the browser not to evict our data under storage pressure.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  buildStaticUi();
  bindEvents();
  bindSyncEvents();
  bindLargeTitles();
  renderAll();
  renderSyncStatus();
  showView(viewFromHash());
  if (syncEnabled() && queueSize() > 0) runSync(); // finish uploads from last time
  registerServiceWorker();
}

async function loadAll() {
  const [tabs, drinks, meta] = await Promise.all([getAll('tabs'), getAll('drinks'), getAll('meta')]);
  if (tabs.length === 0) {
    const seeded = defaultTabs();
    await putAll('tabs', seeded);
    tabs.push(...seeded);
  }
  tabs.sort((a, b) => a.order - b.order);
  // Safety net: any drink pointing at a missing tab is moved, never dropped.
  const ids = new Set(tabs.map((t) => t.id));
  const orphans = drinks.filter((d) => !ids.has(d.tabId));
  if (orphans.length) {
    const target = fallbackTabId(tabs);
    orphans.forEach((d) => { d.tabId = target; });
    await putAll('drinks', orphans);
  }
  const settings = meta.find((m) => m.key === 'settings');
  state.tabs = tabs;
  state.drinks = drinks.map(withOriginFields);
  state.settings.currency = (settings && settings.currency) || '€';
}

function buildStaticUi() {
  // Min rating filter options
  const minSel = $('#minRating');
  minSel.append(el('option', { value: '0' }, 'Any'));
  for (let i = 1; i <= 10; i++) minSel.append(el('option', { value: String(i) }, `${i}+`));

  // 10 rating stars
  const stars = $('#stars');
  for (let i = 1; i <= 10; i++) {
    const b = el('button', { type: 'button', class: 'star', role: 'radio', 'aria-checked': 'false', 'aria-label': `${i} of 10`, 'data-value': String(i) }, '★');
    stars.append(b);
  }

  // Country suggestions for the origin field
  $('#countryList').replaceChildren(...COUNTRIES.map((c) => el('option', { value: c[0] })));
}

function bindEvents() {
  $('#addBtn').addEventListener('click', () => openDrinkDialog(null));
  document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.go)));
  window.addEventListener('hashchange', () => showView(viewFromHash()));
  $('#editTabsBtn').addEventListener('click', openTabsDialog);

  // Filters re-render the list
  ['#search', '#minRating', '#sort', '#maxPerLiter'].forEach((s) => $(s).addEventListener('input', renderList));

  // Every [data-close] button closes its dialog
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  // Drink form
  $('#drinkForm').addEventListener('submit', saveDrink);
  ['#fPrice', '#fVolume', '#fUnit', '#fAbv'].forEach((s) => $(s).addEventListener('input', updateCalc));
  $('#stars').addEventListener('click', (e) => {
    const b = e.target.closest('.star');
    if (b) setRating(Number(b.dataset.value));
  });
  $('#stars').addEventListener('keydown', (e) => {
    const cur = Number($('#fRating').value) || 0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { setRating(Math.min(10, cur + 1)); e.preventDefault(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { setRating(Math.max(1, cur - 1)); e.preventDefault(); }
  });
  document.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => $('#' + b.dataset.pick).click()));
  $('#photoCamera').addEventListener('change', (e) => onPhotoChosen(e.target));
  $('#photoGallery').addEventListener('change', (e) => onPhotoChosen(e.target));
  $('#photoRemove').addEventListener('click', () => { state.formPhoto = null; state.formThumb = null; renderPhotoPreview(); });
  $('#deleteDrinkBtn').addEventListener('click', deleteDrink);
  $('#identifyBtn').addEventListener('click', identifyDrink);
  $('#ocrBtn').addEventListener('click', readLabel);
  $('#fCategory').addEventListener('change', () => { state.categoryTouched = true; });
  // Editing an AI-filled field removes its highlight
  $('#drinkForm').addEventListener('input', (e) => {
    const row = e.target.closest('.frow');
    if (row) row.classList.remove('ai-filled');
  });
  // Tap outside an opened swipe row closes it
  document.addEventListener('pointerdown', (e) => {
    if (openSwipeRow && !openSwipeRow.contains(e.target)) closeSwipe(openSwipeRow);
  });
  $('#groupList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (b) { $('#groupDialog').close(); openDrinkDialog(b.dataset.id); }
  });

  // AI settings
  $('#aiKey').addEventListener('change', saveAiConfig);
  $('#aiWebSearch').addEventListener('change', saveAiConfig);

  // Image viewer: click anywhere to close, free the object URL afterwards
  $('#imageDialog').addEventListener('click', () => $('#imageDialog').close());
  $('#imageDialog').addEventListener('close', () => {
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = null;
    $('#viewerImg').removeAttribute('src');
  });

  // Tabs
  $('#addTabForm').addEventListener('submit', addTab);
  $('#delTabConfirm').addEventListener('click', confirmDeleteTab);

  // Settings + backup
  $('#currency').addEventListener('change', saveCurrency);
  $('#exportBtn').addEventListener('click', exportData);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importData(file);
  });
}

/* ---------- Rendering ---------- */

function renderAll() {
  renderTabs();
  renderList();
  if (state.view === 'map') renderMap();
}

function renderTabs() {
  const nav = $('#tabs');
  const counts = {};
  state.drinks.forEach((d) => { counts[d.tabId] = (counts[d.tabId] || 0) + 1; });
  const make = (id, name, count) => {
    const b = el('button', { type: 'button', class: 'pill', 'aria-pressed': String(state.tab === id) },
      name, el('span', { class: 'count' }, String(count)));
    b.addEventListener('click', () => { state.tab = id; renderAll(); });
    return b;
  };
  const edit = el('button', { type: 'button', class: 'pill edit' }, 'Edit');
  edit.addEventListener('click', openTabsDialog);
  nav.replaceChildren(make(ALL, 'All', state.drinks.length),
    ...state.tabs.map((t) => make(t.id, t.name, counts[t.id] || 0)), edit);
}

function readFilters() {
  const maxInput = $('#maxPerLiter');
  const max = parseNumber(maxInput.value);
  const maxValid = max === null || (!Number.isNaN(max) && max >= 0);
  maxInput.setAttribute('aria-invalid', String(!maxValid));
  return {
    tabId: state.tab,
    search: $('#search').value,
    minRating: Number($('#minRating').value) || 0,
    maxPerLiter: maxValid ? max : null,
    sort: $('#sort').value,
  };
}

function renderList() {
  const rows = applyView(state.drinks, readFilters());
  const bestId = rows.length > 1 ? pickBestValue(rows) : null;
  openSwipeRow = null;
  $('#list').replaceChildren(...rows.map((d) => drinkRow(d, d.id === bestId)));
  $('#empty').hidden = rows.length > 0;
  $('#summary').textContent = `${rows.length} of ${state.drinks.length} drink${state.drinks.length === 1 ? '' : 's'}`
    + (bestId ? ' · “Best value” = highest rating per price per liter' : '');
  pruneThumbUrls();
}

/** Object URL for a drink's thumbnail, cached until the blob changes. */
function thumbUrl(d) {
  const cached = thumbUrls.get(d.id);
  if (cached && cached.blob === d.thumb) return cached.url;
  if (cached) URL.revokeObjectURL(cached.url);
  const url = URL.createObjectURL(d.thumb);
  thumbUrls.set(d.id, { blob: d.thumb, url });
  return url;
}

function pruneThumbUrls() {
  const byId = new Map(state.drinks.map((d) => [d.id, d]));
  for (const [id, c] of thumbUrls) {
    const d = byId.get(id);
    if (!d || d.thumb !== c.blob) { URL.revokeObjectURL(c.url); thumbUrls.delete(id); }
  }
}

/** One list row: photo, name, details, prices, rating. Swipe left to delete. */
function drinkRow(d, isBest) {
  let thumb;
  if (d.thumb) {
    thumb = el('button', { type: 'button', class: 'thumb', 'aria-label': `Show photo of ${d.name}` },
      el('img', { src: thumbUrl(d), alt: '', loading: 'lazy' }));
    thumb.addEventListener('click', (e) => { e.stopPropagation(); if (!swipeJustEnded) showImage(d); });
  } else {
    thumb = el('div', { class: 'thumb', 'aria-hidden': 'true' }, '🍷');
  }

  const sub = [tabName(d.tabId), d.brand, d.country].filter(Boolean).join(' · ');
  const details = [
    d.volume ? `${NUM.format(d.volume)} ${d.volumeUnit}` : null,
    d.abv !== null && d.abv !== undefined ? `${NUM.format(d.abv)} %` : null,
  ].filter(Boolean).join(' · ');
  const price = (label, v) => (typeof v === 'number' ? el('span', {}, label ? label + ' ' : '', el('b', {}, money(v))) : null);
  const prices = [price('', d.price), price('/l', d.perLiter), price('/l alc.', d.perAlcoholLiter)].filter(Boolean);

  const row = el('div', { class: 'drink-row', tabindex: '0', role: 'button', 'aria-label': `Edit ${d.name}` },
    thumb,
    el('div', { class: 'row-main' },
      el('div', { class: 'row-title' }, el('span', { class: 'name' }, d.name),
        isBest ? el('span', { class: 'badge' }, 'Best value') : null),
      el('div', { class: 'row-sub' }, sub + (details ? ` · ${details}` : '')),
      prices.length ? el('div', { class: 'row-prices' }, ...prices) : null),
    el('span', { class: 'rating-badge', 'aria-label': `Rating ${d.rating} of 10` }, String(d.rating)));

  const del = el('button', { type: 'button', class: 'swipe-delete', tabindex: '-1' }, 'Delete');
  const li = el('li', { class: isBest ? 'best' : null }, del, row);
  del.addEventListener('click', async () => {
    if (confirm(`Delete “${d.name}”? This cannot be undone.`)) await deleteDrinkById(d.id);
    else closeSwipe(li);
  });
  row.addEventListener('click', () => {
    if (swipeJustEnded) return;
    if (li.classList.contains('open')) { closeSwipe(li); return; }
    openDrinkDialog(d.id);
  });
  row.addEventListener('keydown', (e) => {
    if (e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDrinkDialog(d.id); }
  });
  attachSwipe(li, row);
  return li;
}

function showImage(d) {
  if (!d.photo) return;
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = URL.createObjectURL(d.photo);
  $('#viewerImg').src = viewerUrl;
  $('#viewerImg').alt = `Photo of ${d.name}`;
  $('#viewerCaption').textContent = d.name;
  $('#imageDialog').showModal();
}

/* ---------- Drink form ---------- */

function fillCategorySelect(select, selectedId, excludeId) {
  select.replaceChildren(...state.tabs.filter((t) => t.id !== excludeId)
    .map((t) => el('option', { value: t.id }, t.name)));
  if (selectedId) select.value = selectedId;
}

function openDrinkDialog(id) {
  const d = id ? state.drinks.find((x) => x.id === id) : null;
  state.editingId = d ? d.id : null;
  $('#drinkForm').reset();
  showErrors({});
  $('#drinkTitle').textContent = d ? 'Edit Drink' : 'New Drink';
  state.categoryTouched = Boolean(d); // AI may only pick the category for new drinks
  resetAiUi();
  fillCategorySelect($('#fCategory'), d ? d.tabId : (state.tab !== ALL ? state.tab : state.tabs[0].id));
  const str = (v) => (v === null || v === undefined ? '' : String(v));
  $('#fName').value = d ? d.name : '';
  $('#fBrand').value = d ? d.brand : '';
  $('#fNotes').value = d ? d.notes : '';
  $('#fPrice').value = d && d.price !== null ? d.price.toFixed(2) : '';
  $('#fVolume').value = d ? str(d.volume) : '';
  $('#fUnit').value = d ? d.volumeUnit : 'ml';
  $('#fAbv').value = d ? str(d.abv) : '';
  $('#fCountry').value = d ? str(d.country) : '';
  $('#fRegion').value = d ? str(d.region) : '';
  setRating(d ? d.rating : 0);
  state.formPhoto = d ? d.photo || null : null;
  state.formThumb = d ? d.thumb || null : null;
  renderPhotoPreview();
  $('#deleteDrinkBtn').hidden = !d;
  $('#deleteDrinkGroup').hidden = !d;
  updateCalc();
  $('#drinkDialog').showModal();
}

function setRating(n) {
  $('#fRating').value = String(n);
  document.querySelectorAll('#stars .star').forEach((s, i) => {
    s.classList.toggle('on', i < n);
    s.setAttribute('aria-checked', String(i + 1 === n));
    s.tabIndex = (n ? i + 1 === n : i === 0) ? 0 : -1;
  });
  $('#ratingOut').textContent = n ? `${n}/10` : '–/10';
  if (n) $('[data-err="rating"]').textContent = '';
}

function readForm() {
  return {
    name: $('#fName').value,
    tabId: $('#fCategory').value,
    brand: $('#fBrand').value,
    notes: $('#fNotes').value,
    rating: $('#fRating').value,
    price: $('#fPrice').value,
    volume: $('#fVolume').value,
    volumeUnit: $('#fUnit').value,
    abv: $('#fAbv').value,
    country: $('#fCountry').value,
    region: $('#fRegion').value,
  };
}

/** Live price calculation while typing. */
function updateCalc() {
  const { errors, values } = validateDrink(readForm());
  // Only show results computed from valid inputs.
  const ok = !errors.price && !errors.volume && !errors.abv;
  const r = ok ? calcPrices(values.price, values.volume, values.volumeUnit, values.abv) : {};
  $('#calcPerLiter').textContent = money(r.perLiter);
  $('#calcPerAlc').textContent = money(r.perAlcoholLiter);
}

function showErrors(errors) {
  document.querySelectorAll('#drinkForm [data-err]').forEach((s) => { s.textContent = errors[s.dataset.err] || ''; });
  const map = { name: '#fName', tabId: '#fCategory', price: '#fPrice', volume: '#fVolume', abv: '#fAbv' };
  for (const [key, sel] of Object.entries(map)) $(sel).setAttribute('aria-invalid', String(Boolean(errors[key])));
}

async function saveDrink(e) {
  e.preventDefault();
  const { errors, values } = validateDrink(readForm());
  showErrors(errors);
  const firstError = Object.keys(errors)[0];
  if (firstError) {
    const focusMap = { name: '#fName', tabId: '#fCategory', rating: '#stars .star', price: '#fPrice', volume: '#fVolume', abv: '#fAbv' };
    $(focusMap[firstError]).focus();
    return;
  }
  const now = Date.now();
  const existing = state.editingId ? state.drinks.find((d) => d.id === state.editingId) : null;
  const drink = Object.assign({}, existing, values, {
    id: existing ? existing.id : uid(),
    photo: state.formPhoto,
    thumb: state.formThumb,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  });
  const btn = $('#saveDrinkBtn');
  btn.disabled = true;
  try {
    await putAll('drinks', [drink]);
  } catch (err) {
    alert('Could not save: ' + err.message);
    return;
  } finally {
    btn.disabled = false;
  }
  state.drinks = existing ? state.drinks.map((d) => (d.id === drink.id ? drink : d)) : [...state.drinks, drink];
  $('#drinkDialog').close();
  renderAll();
  queueSync({ drinkIds: [drink.id] });
  geocodeDrink(drink.id); // in the background; the map falls back to the country position
}

async function deleteDrink() {
  const d = state.drinks.find((x) => x.id === state.editingId);
  if (!d || !confirm(`Delete “${d.name}”? This cannot be undone.`)) return;
  if (await deleteDrinkById(d.id)) $('#drinkDialog').close();
}

async function deleteDrinkById(id) {
  try {
    await deleteKey('drinks', id);
  } catch (err) {
    alert('Could not delete: ' + err.message);
    return false;
  }
  state.drinks = state.drinks.filter((x) => x.id !== id);
  renderAll();
  queueSync({ drinkIds: [id] });
  return true;
}

async function onPhotoChosen(input) {
  const file = input.files && input.files[0];
  input.value = ''; // allow picking the same file again
  if (!file) return;
  setPhotoBusy(true);
  try {
    const photo = await resizeImage(file, 1200, 0.85);
    const thumb = await resizeImage(photo, 320, 0.8);
    state.formPhoto = photo;
    state.formThumb = thumb;
    renderPhotoPreview();
  } catch (err) {
    alert('Could not read this image. Please try a JPEG or PNG photo.');
  } finally {
    setPhotoBusy(false);
  }
}

function setPhotoBusy(busy) {
  $('#photoBusy').hidden = !busy;
  $('#saveDrinkBtn').disabled = busy;
  document.querySelectorAll('[data-pick]').forEach((b) => { b.disabled = busy; });
}

function renderPhotoPreview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  const box = $('#photoPreview');
  if (state.formThumb) {
    previewUrl = URL.createObjectURL(state.formThumb);
    box.replaceChildren(el('img', { src: previewUrl, alt: 'Selected photo' }));
  } else {
    box.replaceChildren(el('span', {}, 'No photo'));
  }
  $('#photoRemove').hidden = !state.formThumb;
  $('#readButtons').hidden = !state.formPhoto;
}

/* ---------- Tabs management ---------- */

function openTabsDialog() {
  $('#tabError').textContent = '';
  $('#newTabName').value = '';
  renderTabsDialog();
  $('#tabsDialog').showModal();
}

function renderTabsDialog() {
  const counts = {};
  state.drinks.forEach((d) => { counts[d.tabId] = (counts[d.tabId] || 0) + 1; });
  $('#tabList').replaceChildren(...state.tabs.map((t) => {
    const input = el('input', { type: 'text', maxlength: '30', value: t.name, class: 'left', 'aria-label': `Rename ${t.name}` });
    input.addEventListener('change', () => renameTab(t.id, input));
    const del = el('button', { type: 'button', class: 'text-btn del', 'aria-label': `Delete ${t.name}` }, 'Delete');
    del.addEventListener('click', () => openDeleteTab(t.id));
    return el('li', {}, el('div', { class: 'frow' }, input, el('span', { class: 'count' }, `${counts[t.id] || 0}`), del));
  }));
}

async function renameTab(id, input) {
  const tab = state.tabs.find((t) => t.id === id);
  const err = validateTabName(input.value, state.tabs, id);
  if (err) {
    $('#tabError').textContent = err;
    input.value = tab.name;
    return;
  }
  $('#tabError').textContent = '';
  const updated = Object.assign({}, tab, { name: input.value.trim() });
  try { await putAll('tabs', [updated]); } catch (e) { $('#tabError').textContent = 'Could not save: ' + e.message; return; }
  state.tabs = state.tabs.map((t) => (t.id === id ? updated : t));
  renderAll();
  queueSync({ config: true });
}

async function addTab(e) {
  e.preventDefault();
  const input = $('#newTabName');
  const err = validateTabName(input.value, state.tabs);
  if (err) { $('#tabError').textContent = err; return; }
  const order = state.tabs.reduce((m, t) => Math.max(m, t.order), -1) + 1;
  const tab = { id: uid(), name: input.value.trim(), order };
  try { await putAll('tabs', [tab]); } catch (e2) { $('#tabError').textContent = 'Could not save: ' + e2.message; return; }
  state.tabs = [...state.tabs, tab];
  input.value = '';
  $('#tabError').textContent = '';
  renderTabsDialog();
  renderAll();
  queueSync({ config: true });
}

function openDeleteTab(id) {
  if (state.tabs.length <= 1) {
    $('#tabError').textContent = 'You need at least one category.';
    return;
  }
  const tab = state.tabs.find((t) => t.id === id);
  const count = state.drinks.filter((d) => d.tabId === id).length;
  state.deletingTabId = id;
  $('#delTabText').textContent = count
    ? `“${tab.name}” contains ${count} drink${count === 1 ? '' : 's'}. They will be moved to another category, not deleted.`
    : `Delete the empty category “${tab.name}”?`;
  const others = state.tabs.filter((t) => t.id !== id);
  fillCategorySelect($('#delTabTarget'), fallbackTabId(others), id);
  $('#delTabMove').hidden = count === 0;
  $('#deleteTabDialog').showModal();
}

/** Move the tab's drinks and delete the tab in a single transaction. */
async function confirmDeleteTab() {
  const id = state.deletingTabId;
  const target = $('#delTabTarget').value;
  if (!id || !target || target === id) return;
  const moved = state.drinks.filter((d) => d.tabId === id).map((d) => Object.assign({}, d, { tabId: target }));
  try {
    const t = db.transaction(['tabs', 'drinks'], 'readwrite');
    moved.forEach((d) => t.objectStore('drinks').put(d));
    t.objectStore('tabs').delete(id);
    await txDone(t);
  } catch (err) {
    alert('Could not delete tab: ' + err.message);
    return;
  }
  const movedById = new Map(moved.map((d) => [d.id, d]));
  state.drinks = state.drinks.map((d) => movedById.get(d.id) || d);
  state.tabs = state.tabs.filter((t) => t.id !== id);
  if (state.tab === id) state.tab = ALL;
  state.deletingTabId = null;
  $('#deleteTabDialog').close();
  renderTabsDialog();
  renderAll();
  queueSync({ config: true, drinkIds: moved.map((d) => d.id) });
}

/* ---------- Settings, export, import ---------- */

function openSettings() {
  showView('settings');
}

/** Fill the settings page with the current values. */
function fillSettings() {
  $('#currency').value = state.settings.currency;
  $('#aiKey').value = ai.key;
  $('#aiWebSearch').checked = ai.webSearch;
  fillSyncForm();
}

async function saveCurrency() {
  const value = $('#currency').value.trim().slice(0, 5) || '€';
  $('#currency').value = value;
  try { await putAll('meta', [{ key: 'settings', currency: value }]); } catch (e) { alert('Could not save: ' + e.message); return; }
  state.settings.currency = value;
  renderList();
  queueSync({ config: true });
}

async function exportData() {
  try {
    const drinks = await Promise.all(state.drinks.map(async (d) => Object.assign({}, d, {
      photo: d.photo ? await blobToDataUrl(d.photo) : null,
      thumb: d.thumb ? await blobToDataUrl(d.thumb) : null,
    })));
    const data = { app: 'drink-tracker', version: 1, exportedAt: new Date().toISOString(), settings: state.settings, tabs: state.tabs, drinks };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `drinks-backup-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (err) {
    alert('Export failed: ' + err.message);
  }
}

async function importData(file) {
  let parsed;
  try {
    parsed = parseBackup(JSON.parse(await file.text()));
  } catch (err) {
    alert('Import failed: ' + (err instanceof SyntaxError ? 'the file is not valid JSON.' : err.message));
    return;
  }
  if (!confirm(`Import ${parsed.drinks.length} drinks and ${parsed.tabs.length} tabs?\n\nThis REPLACES all current data. Export first if you want to keep it.`)) return;
  try {
    await replaceAllData(parsed);
  } catch (err) {
    alert('Import failed, nothing was changed: ' + err.message);
    return;
  }
  alert('Import complete.');
  if (syncEnabled()) uploadEverything({ mirror: true }); // make GitHub match the imported data
}

/** Replace all local tabs, drinks and settings in one transaction (sync config is kept). */
async function replaceAllData(parsed) {
  // Convert photos before opening the transaction (it must not wait on async work).
  for (const d of parsed.drinks) {
    if (typeof d.photo === 'string') d.photo = dataUrlToBlob(d.photo);
    if (typeof d.thumb === 'string') d.thumb = dataUrlToBlob(d.thumb);
    if (d.photo && (!d.thumb || d.thumb === d.photo)) d.thumb = await resizeImage(d.photo, 320, 0.8);
    if (!d.photo) d.thumb = null;
  }
  const t = db.transaction(['tabs', 'drinks', 'meta'], 'readwrite');
  ['tabs', 'drinks'].forEach((s) => t.objectStore(s).clear());
  parsed.tabs.forEach((x) => t.objectStore('tabs').put(x));
  parsed.drinks.forEach((x) => t.objectStore('drinks').put(x));
  t.objectStore('meta').put({ key: 'settings', currency: parsed.settings.currency });
  await txDone(t);
  await loadAll();
  state.tab = ALL;
  renderAll();
}

/* =====================================================================
   GitHub sync: every change is saved as files in a GitHub repository.
   drinks/<id>.json, photos/<id>.jpg, config.json (tabs + settings).
   Pending changes are queued in IndexedDB and retried, so nothing is
   lost while offline. The token is stored only on this device.
   ===================================================================== */

const sync = {
  cfg: { repo: '', branch: 'data', token: '' },
  queue: { config: false, drinks: {} }, // drinks: id -> change counter
  running: false,
  branchReady: false,
  error: '',
  retryTimer: null,
};

function syncEnabled() {
  return Boolean(sync.cfg.repo && sync.cfg.token);
}

function queueSize() {
  return Object.keys(sync.queue.drinks).length + (sync.queue.config ? 1 : 0);
}

function saveQueue() {
  return putAll('meta', [Object.assign({ key: 'syncQueue' }, sync.queue)]);
}

/** Mark things as changed and start uploading. Safe to call when sync is off. */
async function queueSync({ config = false, drinkIds = [] }) {
  if (!syncEnabled()) return;
  if (config) sync.queue.config = true;
  drinkIds.forEach((id) => { sync.queue.drinks[id] = (sync.queue.drinks[id] || 0) + 1; });
  renderSyncStatus();
  try { await saveQueue(); } catch (e) { /* queue stays in memory */ }
  runSync();
}

/** Upload queued changes one by one until the queue is empty. */
async function runSync() {
  if (!syncEnabled() || sync.running) return;
  clearTimeout(sync.retryTimer);
  sync.running = true;
  sync.error = '';
  renderSyncStatus();
  try {
    await ensureBranch();
    while (queueSize() > 0) {
      if (sync.queue.config) {
        sync.queue.config = false;
        try {
          await putFile('config.json', jsonBytes(remoteConfig()), 'Update tabs and settings');
        } catch (e) { sync.queue.config = true; throw e; }
      } else {
        const id = Object.keys(sync.queue.drinks)[0];
        const version = sync.queue.drinks[id];
        await syncDrink(id);
        // Only drop it if it wasn't changed again while uploading.
        if (sync.queue.drinks[id] === version) delete sync.queue.drinks[id];
      }
      await saveQueue();
      renderSyncStatus();
    }
  } catch (err) {
    sync.error = err.message;
    sync.retryTimer = setTimeout(runSync, 60000);
  } finally {
    sync.running = false;
    renderSyncStatus();
  }
  if (!sync.error && queueSize() > 0) runSync();
}

async function syncDrink(id) {
  const d = state.drinks.find((x) => x.id === id);
  if (d) {
    await putFile(`drinks/${id}.json`, jsonBytes(drinkToRemote(d)), `Save drink “${d.name}”`);
    if (d.photo) await putFile(`photos/${id}.jpg`, new Uint8Array(await d.photo.arrayBuffer()), `Save photo of “${d.name}”`);
    else await deleteFile(`photos/${id}.jpg`, 'Remove photo');
  } else {
    await deleteFile(`drinks/${id}.json`, 'Delete drink');
    await deleteFile(`photos/${id}.jpg`, 'Delete photo');
  }
}

/** Drink as stored on GitHub (photo lives in its own file). */
function drinkToRemote(d) {
  const out = {};
  ['id', 'name', 'tabId', 'brand', 'notes', 'rating', 'price', 'volume', 'volumeUnit', 'abv',
    'country', 'region', 'lat', 'lng', 'geoQuery', 'createdAt', 'updatedAt']
    .forEach((k) => { out[k] = d[k] === undefined ? null : d[k]; });
  out.hasPhoto = Boolean(d.photo);
  return out;
}

function remoteConfig() {
  return { app: 'drink-tracker', version: 1, settings: { currency: state.settings.currency }, tabs: state.tabs };
}

function jsonBytes(obj) {
  return new TextEncoder().encode(JSON.stringify(obj, null, 2) + '\n');
}

function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Git's blob hash, used to skip uploads of unchanged files. */
async function gitBlobSha(bytes) {
  if (!(globalThis.crypto && crypto.subtle)) return null;
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(head.length + bytes.length);
  all.set(head);
  all.set(bytes, head.length);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', all));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Call the GitHub REST API. */
async function gh(method, path, { body, raw, allow404 } = {}) {
  let res;
  try {
    res = await fetch('https://api.github.com' + path, {
      method,
      cache: 'no-store',
      headers: Object.assign({
        Authorization: 'Bearer ' + sync.cfg.token,
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error('No connection to GitHub.');
  }
  if (res.status === 404 && allow404) return null;
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch (e) { /* no JSON body */ }
    if (res.status === 401) throw new Error('The token is invalid or expired.');
    if (res.status === 404) throw new Error('Repository not found, or the token has no access to it.');
    if (res.status === 403) throw new Error('The token is not allowed to write to this repository. ' + msg);
    throw new Error(`GitHub error ${res.status}: ${msg}`);
  }
  if (raw) return res;
  return res.status === 204 ? null : res.json();
}

function contentsPath(path) {
  return `/repos/${sync.cfg.repo}/contents/${path}?ref=${encodeURIComponent(sync.cfg.branch)}`;
}

async function remoteSha(path) {
  const r = await gh('GET', contentsPath(path), { allow404: true });
  return r && !Array.isArray(r) ? r.sha : null;
}

async function putFile(path, bytes, message) {
  const sha = await remoteSha(path);
  if (sha && sha === await gitBlobSha(bytes)) return; // unchanged
  await gh('PUT', `/repos/${sync.cfg.repo}/contents/${path}`, {
    body: { message, content: bytesToBase64(bytes), branch: sync.cfg.branch, sha: sha || undefined },
  });
}

async function deleteFile(path, message) {
  const sha = await remoteSha(path);
  if (!sha) return;
  await gh('DELETE', `/repos/${sync.cfg.repo}/contents/${path}`, { body: { message, sha, branch: sync.cfg.branch } });
}

/** Create the data branch from the default branch if it does not exist yet. */
async function ensureBranch() {
  if (sync.branchReady) return;
  const branch = encodeURIComponent(sync.cfg.branch);
  const ref = await gh('GET', `/repos/${sync.cfg.repo}/git/ref/heads/${branch}`, { allow404: true });
  if (!ref) {
    const repo = await gh('GET', `/repos/${sync.cfg.repo}`);
    const base = await gh('GET', `/repos/${sync.cfg.repo}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`, { allow404: true });
    if (!base) throw new Error('The repository is empty. Add any file (e.g. a README) on GitHub first.');
    await gh('POST', `/repos/${sync.cfg.repo}/git/refs`, { body: { ref: `refs/heads/${sync.cfg.branch}`, sha: base.object.sha } });
  }
  sync.branchReady = true;
}

async function listRemoteDrinkIds() {
  const list = await gh('GET', contentsPath('drinks'), { allow404: true });
  return (Array.isArray(list) ? list : [])
    .filter((f) => f.type === 'file' && f.name.endsWith('.json'))
    .map((f) => f.name.slice(0, -5));
}

/** Queue every local drink. With mirror=true, drinks on GitHub that are not on
 *  this device are deleted there too (only used after a JSON import). */
async function uploadEverything({ mirror = false } = {}) {
  let remoteIds = [];
  if (mirror) {
    try { await ensureBranch(); remoteIds = await listRemoteDrinkIds(); } catch (e) { /* runSync reports errors */ }
  }
  const ids = new Set([...state.drinks.map((d) => d.id), ...remoteIds]);
  await queueSync({ config: true, drinkIds: [...ids] });
}

/** Download everything from GitHub and replace the local data. */
async function restoreFromGitHub(askFirst = true) {
  const msg = $('#ghMsg');
  try {
    msg.textContent = 'Downloading from GitHub…';
    await ensureBranch();
    const cfgRes = await gh('GET', contentsPath('config.json'), { raw: true, allow404: true });
    if (!cfgRes) throw new Error('No saved data found in this repository/branch.');
    const cfg = await cfgRes.json();
    const ids = await listRemoteDrinkIds();
    const drinks = [];
    for (const id of ids) {
      msg.textContent = `Downloading drink ${drinks.length + 1} of ${ids.length}…`;
      const d = await (await gh('GET', contentsPath(`drinks/${id}.json`), { raw: true })).json();
      if (d.hasPhoto) {
        const p = await gh('GET', contentsPath(`photos/${id}.jpg`), { raw: true, allow404: true });
        d.photo = p ? new Blob([await p.arrayBuffer()], { type: 'image/jpeg' }) : null;
      }
      drinks.push(d);
    }
    const parsed = parseBackup({ tabs: cfg.tabs || [], settings: cfg.settings, drinks });
    msg.textContent = '';
    if (askFirst && !confirm(`Restore ${parsed.drinks.length} drinks and ${parsed.tabs.length} tabs from GitHub?\n\nThis REPLACES the data on this device.`)) return;
    await replaceAllData(parsed);
    sync.queue = { config: false, drinks: {} }; // local now equals remote
    await saveQueue();
    renderSyncStatus();
    msg.textContent = 'Restore complete.';
  } catch (err) {
    msg.textContent = 'Restore failed: ' + err.message;
  }
}

/** Suggest owner/repo when the app is hosted on GitHub Pages. */
function guessRepo() {
  const host = location.hostname;
  if (!host.endsWith('.github.io')) return '';
  const owner = host.split('.')[0];
  const repo = location.pathname.split('/')[1] || host;
  return `${owner}/${repo}`;
}

async function loadSyncConfig() {
  const meta = await getAll('meta');
  const cfg = meta.find((m) => m.key === 'sync');
  const queue = meta.find((m) => m.key === 'syncQueue');
  if (cfg) sync.cfg = { repo: cfg.repo || '', branch: cfg.branch || 'data', token: cfg.token || '' };
  if (queue) sync.queue = { config: Boolean(queue.config), drinks: queue.drinks || {} };
}

function fillSyncForm() {
  $('#ghRepo').value = sync.cfg.repo || guessRepo();
  $('#ghBranch').value = sync.cfg.branch || 'data';
  $('#ghToken').value = sync.cfg.token;
  $('#ghConnected').hidden = !syncEnabled();
}

async function connectGitHub() {
  const msg = $('#ghMsg');
  const repo = $('#ghRepo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
  const branch = $('#ghBranch').value.trim() || 'data';
  const token = $('#ghToken').value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { msg.textContent = 'Enter the repository as owner/name.'; return; }
  if (!token) { msg.textContent = 'Enter an access token.'; return; }
  const firstTime = !syncEnabled() || sync.cfg.repo !== repo || sync.cfg.branch !== branch;
  const previous = sync.cfg;
  sync.cfg = { repo, branch, token };
  sync.branchReady = false;
  msg.textContent = 'Connecting…';
  try {
    const info = await gh('GET', `/repos/${repo}`);
    if (info.permissions && !info.permissions.push) throw new Error('The token can read but not write this repository.');
    await ensureBranch();
    await putAll('meta', [{ key: 'sync', repo, branch, token }]);
    msg.textContent = `Connected to ${repo} (branch “${branch}”).` + (info.private ? '' : ' Note: this repository is PUBLIC.');
    fillSyncForm();
    if (firstTime) {
      const remoteIds = await listRemoteDrinkIds();
      if (remoteIds.length && confirm(`GitHub already has ${remoteIds.length} saved drinks.\n\nOK = load them onto this device (replaces the data here).\nCancel = keep the data here and add it to GitHub.`)) {
        await restoreFromGitHub(false);
        renderSyncStatus();
        return;
      }
      await uploadEverything();
    } else {
      runSync();
    }
  } catch (err) {
    sync.cfg = previous; // keep the old working connection (if any) and what was typed
    sync.branchReady = false;
    msg.textContent = 'Could not connect: ' + err.message;
  }
  renderSyncStatus();
}

async function disconnectGitHub() {
  if (!confirm('Stop saving to GitHub on this device? Data already on GitHub stays there.')) return;
  sync.cfg = { repo: '', branch: 'data', token: '' };
  sync.queue = { config: false, drinks: {} };
  sync.branchReady = false;
  clearTimeout(sync.retryTimer);
  await putAll('meta', [{ key: 'sync', repo: '', branch: 'data', token: '' }]);
  await saveQueue();
  fillSyncForm();
  $('#ghMsg').textContent = 'Disconnected.';
  renderSyncStatus();
}

function renderSyncStatus() {
  const b = $('#syncStatus');
  if (!b) return;
  b.hidden = !syncEnabled();
  b.classList.toggle('error', Boolean(sync.error));
  const n = queueSize();
  if (sync.error) b.textContent = `⚠ Not saved to GitHub (${n}) – tap to retry`;
  else if (n > 0) b.textContent = `☁ Saving to GitHub… (${n})`;
  else b.textContent = '☁ Saved to GitHub';
  b.title = sync.error || '';
}

function bindSyncEvents() {
  $('#ghConnect').addEventListener('click', connectGitHub);
  $('#ghDisconnect').addEventListener('click', disconnectGitHub);
  $('#ghUploadAll').addEventListener('click', async () => {
    $('#ghMsg').textContent = 'Uploading everything…';
    await uploadEverything();
    $('#ghMsg').textContent = sync.error ? 'Upload failed: ' + sync.error : 'Upload started – see status at the top.';
  });
  $('#ghRestore').addEventListener('click', () => restoreFromGitHub(true));
  $('#syncStatus').addEventListener('click', () => { if (sync.error) runSync(); else openSettings(); });
  window.addEventListener('online', runSync);
}

/* =====================================================================
   Views (bottom tab bar) and collapsing large titles
   ===================================================================== */

const VIEWS = ['drinks', 'map', 'settings'];

function viewFromHash() {
  const v = location.hash.replace('#', '');
  return VIEWS.includes(v) ? v : 'drinks';
}

function showView(name) {
  if (!VIEWS.includes(name)) name = 'drinks';
  const changed = state.view !== name;
  state.view = name;
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
  document.querySelectorAll('[data-go]').forEach((b) => {
    if (b.dataset.go === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  if (changed) window.scrollTo(0, 0);
  if (name === 'settings') fillSettings();
  if (name === 'map') openMapView();
}

/** Show the small navbar title once the large title scrolls away. */
function bindLargeTitles() {
  if (!('IntersectionObserver' in window)) return;
  document.querySelectorAll('.view').forEach((view) => {
    const title = view.querySelector('.large-title');
    const bar = view.querySelector('.navbar');
    new IntersectionObserver(([entry]) => {
      bar.classList.toggle('collapsed', !entry.isIntersecting && !view.hidden);
    }, { rootMargin: '-50px 0px 0px 0px' }).observe(title);
  });
}

/* =====================================================================
   Swipe left on a list row to reveal "Delete"
   ===================================================================== */

const SWIPE_WIDTH = 88;
let openSwipeRow = null;
let swipeJustEnded = false;

function closeSwipe(li) {
  li.classList.remove('open');
  li.querySelector('.drink-row').style.transform = '';
  if (openSwipeRow === li) openSwipeRow = null;
}

function attachSwipe(li, row) {
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let tracking = false;
  let swiping = false;

  row.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    tracking = true;
    swiping = false;
  });
  row.addEventListener('pointermove', (e) => {
    if (!tracking) return;
    const mx = e.clientX - startX;
    const my = e.clientY - startY;
    if (!swiping) {
      if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) { tracking = false; return; } // vertical scroll
      if (Math.abs(mx) < 10) return;
      swiping = true;
      li.classList.add('swiping');
      row.setPointerCapture(e.pointerId);
      if (openSwipeRow && openSwipeRow !== li) closeSwipe(openSwipeRow);
      row.style.transition = 'none';
    }
    const base = li.classList.contains('open') ? -SWIPE_WIDTH : 0;
    dx = Math.max(-SWIPE_WIDTH * 1.4, Math.min(0, base + mx));
    row.style.transform = `translateX(${dx}px)`;
  });
  const end = () => {
    if (!tracking) return;
    tracking = false;
    if (!swiping) return;
    row.style.transition = '';
    li.classList.remove('swiping');
    const open = dx < -SWIPE_WIDTH / 2;
    li.classList.toggle('open', open);
    row.style.transform = open ? `translateX(${-SWIPE_WIDTH}px)` : '';
    openSwipeRow = open ? li : null;
    // The click that follows a swipe must not open the drink.
    swipeJustEnded = true;
    setTimeout(() => { swipeJustEnded = false; }, 50);
  };
  row.addEventListener('pointerup', end);
  row.addEventListener('pointercancel', end);
}

/* =====================================================================
   AI: identify a drink from its photo (Anthropic Messages API)
   ===================================================================== */

const ai = { key: '', webSearch: true };
let aiBusy = false;

async function loadAiConfig() {
  const meta = await getAll('meta');
  const cfg = meta.find((m) => m.key === 'ai');
  if (cfg) {
    ai.key = cfg.apiKey || '';
    ai.webSearch = cfg.webSearch !== false;
  }
}

async function saveAiConfig() {
  ai.key = $('#aiKey').value.trim();
  ai.webSearch = $('#aiWebSearch').checked;
  try { await putAll('meta', [{ key: 'ai', apiKey: ai.key, webSearch: ai.webSearch }]); } catch (e) { alert('Could not save: ' + e.message); }
}

const AI_SYSTEM = `You read labels of alcoholic drinks (bottles, cans, glasses with labels) from photos.
Rules:
- Report only what you can clearly read on the label, or what a web search result explicitly states for this exact product.
- Never guess, estimate or infer. If a value is unreadable, ambiguous, or you are not sure, use null.
- Do not use typical values for a style (e.g. "beers are usually 5%"). Unknown means null.
- Answer with one JSON object only, no other text.`;

function aiPrompt(categories, webSearch) {
  return `Identify the drink in this photo. Return exactly this JSON object:
{
  "name": string|null,          // product name as printed (without the producer if it is separate)
  "brand": string|null,         // producer, brewery, winery or distillery
  "category": string|null,      // exactly one of: ${categories.map((c) => JSON.stringify(c)).join(', ')}; null if none fits clearly
  "abv": number|null,           // alcohol % by volume, e.g. 13.5
  "volume_ml": number|null,     // bottle/can size in milliliters, e.g. 750
  "country": string|null,       // country of origin, English name (e.g. "Germany", "Scotland")
  "region": string|null,        // wine region, city or place of production, if stated
  "description": string|null,   // 1-2 neutral sentences based only on the label or sources
  "from_web": string[]          // names of the fields you took from web search instead of the label
}
${webSearch
    ? 'If name and producer are clearly legible, you may use web search to fill missing abv, volume_ml, country or region for this exact product. Do not search if you cannot identify the product. Use only values a source states explicitly.'
    : 'Do not use any outside knowledge for numbers; only what is printed on the label.'}`;
}

/** Pull the JSON object out of the model's text (handles ```json fences). */
function extractJson(text) {
  if (typeof text !== 'string') return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(candidate.slice(start, end + 1));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch (e) {
    return null;
  }
}

/** Validate the model's answer. Anything doubtful becomes null. */
function sanitizeAiResult(obj, categories) {
  const text = (v, max) => {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s || /^(null|none|unknown|n\/a|not visible|unreadable|-)$/i.test(s)) return null;
    return s.slice(0, max);
  };
  const num = (v) => {
    const n = typeof v === 'number' ? v : parseNumber(typeof v === 'string' ? v.replace(/\s*(%|ml)$/i, '') : null);
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  };
  const o = obj && typeof obj === 'object' ? obj : {};
  const abv = num(o.abv);
  const vol = num(o.volume_ml);
  const cat = text(o.category, 30);
  const match = cat ? categories.find((c) => c.toLowerCase() === cat.toLowerCase()) : null;
  return {
    name: text(o.name, 120),
    brand: text(o.brand, 120),
    category: match || null,
    abv: abv !== null && abv >= 0 && abv <= 100 ? abv : null,
    volumeMl: vol !== null && vol > 0 && vol <= 30000 ? vol : null,
    country: text(o.country, 80),
    region: text(o.region, 80),
    description: text(o.description, 500),
    fromWeb: Array.isArray(o.from_web) ? o.from_web.filter((f) => typeof f === 'string') : [],
  };
}

/** Call the Messages API with the photo. Returns the final response JSON. */
async function callClaude(imageBase64, categories, webSearch) {
  const messages = [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: aiPrompt(categories, webSearch) },
    ],
  }];
  const body = {
    model: AI_MODEL,
    max_tokens: 16000,
    system: AI_SYSTEM,
    output_config: { effort: 'medium' },
    fallbacks: 'default', // if the model declines, the API retries on a fallback model
    messages,
  };
  if (webSearch) body.tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    let collected = [];
    for (let turn = 0; turn < 4; turn++) {
      let res;
      try {
        res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'x-api-key': ai.key,
            'anthropic-version': '2026-10-21',
            'anthropic-beta': 'server-side-fallback-2026-07-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify(body),
        });
      } catch (e) {
        if (e.name === 'AbortError') throw new Error('The request timed out. Please try again.');
        throw new Error('No connection to the Anthropic API.');
      }
      let data = null;
      try { data = await res.json(); } catch (e) { /* not JSON */ }
      if (!res.ok) {
        const msg = (data && data.error && data.error.message) || '';
        if (res.status === 401) throw new Error('The API key was rejected. Check it in Settings.');
        if (res.status === 403) throw new Error('This API key is not allowed to do this. ' + msg);
        if (res.status === 429) throw new Error('Rate limit or credit limit reached. Try again later.');
        if (res.status >= 500) throw new Error('The Anthropic API is busy right now. Try again in a moment.');
        throw new Error(`API error ${res.status}: ${msg}`);
      }
      collected = collected.concat(data.content || []);
      if (data.stop_reason === 'pause_turn') {
        // Long server-side tool use: continue the same turn.
        messages.push({ role: 'assistant', content: data.content });
        continue;
      }
      if (data.stop_reason === 'refusal') throw new Error('The model declined to analyse this photo.');
      if (data.stop_reason === 'max_tokens') throw new Error('The answer was cut off. Please try again.');
      return { content: collected, final: data.content || [] };
    }
    throw new Error('The model did not finish. Please try again.');
  } finally {
    clearTimeout(timer);
  }
}

/** Sources the model cited (or searched) for display. */
function aiSources(content) {
  const seen = new Map();
  content.forEach((b) => {
    if (b.type === 'text' && Array.isArray(b.citations)) {
      b.citations.forEach((c) => { if (c.url && !seen.has(c.url)) seen.set(c.url, { url: c.url, title: c.title || c.url, cited: true }); });
    }
  });
  if (seen.size === 0) {
    content.forEach((b) => {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        b.content.slice(0, 3).forEach((r) => { if (r.url && !seen.has(r.url)) seen.set(r.url, { url: r.url, title: r.title || r.url, cited: false }); });
      }
    });
  }
  return [...seen.values()].filter((s) => /^https?:\/\//.test(s.url)).slice(0, 5);
}

function resetAiUi() {
  $('#aiMsg').hidden = true;
  $('#aiMsg').textContent = '';
  $('#aiSources').hidden = true;
  $('#aiSources').replaceChildren();
  $('#ocrText').hidden = true;
  $('#ocrText').open = false;
  document.querySelectorAll('#drinkForm .ai-filled').forEach((r) => r.classList.remove('ai-filled'));
}

function showAiMsg(text, isError) {
  const m = $('#aiMsg');
  m.textContent = text;
  m.classList.toggle('error', Boolean(isError));
  m.hidden = false;
}

function setAiBusy(busy) {
  aiBusy = busy;
  const b = $('#identifyBtn');
  b.classList.toggle('busy', busy);
  b.textContent = busy ? 'Identifying…' : '✨ Identify with AI';
  updateReadButtons();
}

/** Only one of AI / free label reading runs at a time. */
function updateReadButtons() {
  $('#identifyBtn').disabled = aiBusy || ocrBusy;
  $('#ocrBtn').disabled = aiBusy || ocrBusy;
}

async function identifyDrink() {
  if (aiBusy || ocrBusy || !state.formPhoto) return;
  resetAiUi();
  if (!ai.key) {
    showAiMsg('Add your Anthropic API key in Settings to use this. You can still fill in the form manually.', true);
    return;
  }
  const editingId = state.editingId;
  const categories = state.tabs.map((t) => t.name);
  setAiBusy(true);
  try {
    const b64 = bytesToBase64(new Uint8Array(await state.formPhoto.arrayBuffer()));
    const res = await callClaude(b64, categories, ai.webSearch);
    // Ignore the answer if the sheet was closed or switched to another drink meanwhile.
    if (!$('#drinkDialog').open || state.editingId !== editingId) return;
    const text = res.final.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = extractJson(text);
    if (!parsed) { showAiMsg('The answer could not be read. Please fill in the form manually or try again.', true); return; }
    const r = sanitizeAiResult(parsed, categories);
    const filled = applyAiSuggestions(r);
    const sources = aiSources(res.content);
    renderAiSources(sources);
    if (filled.length === 0) {
      showAiMsg('Nothing new could be read reliably from this photo. Fields you already filled were kept.', false);
    } else {
      showAiMsg(`Filled: ${filled.join(', ')}. Please check the highlighted fields before saving.` +
        (r.fromWeb.length && sources.length ? ' Some values come from the web sources below.' : ''), false);
    }
  } catch (err) {
    showAiMsg(err.message + ' The form still works manually.', true);
  } finally {
    setAiBusy(false);
  }
}

/** Fill only empty fields. Returns labels of the fields that were filled. */
function applyAiSuggestions(r) {
  const filled = [];
  const fill = (sel, value, label) => {
    const input = $(sel);
    if (value === null || value === undefined || input.value.trim() !== '') return;
    input.value = String(value);
    input.closest('.frow').classList.add('ai-filled');
    filled.push(label);
  };
  fill('#fName', r.name, 'name');
  fill('#fBrand', r.brand, 'producer');
  if (r.category && !state.categoryTouched) {
    const tab = state.tabs.find((t) => t.name === r.category);
    if (tab && $('#fCategory').value !== tab.id) {
      $('#fCategory').value = tab.id;
      $('#fCategory').closest('.frow').classList.add('ai-filled');
      filled.push('category');
    }
  }
  if (r.volumeMl !== null && $('#fVolume').value.trim() === '') {
    $('#fUnit').value = 'ml';
    fill('#fVolume', r.volumeMl, 'volume');
  }
  fill('#fAbv', r.abv, 'ABV');
  fill('#fCountry', r.country, 'country');
  fill('#fRegion', r.region, 'region');
  if (r.description && $('#fNotes').value.trim() === '') {
    $('#fNotes').value = r.description;
    filled.push('notes');
  }
  updateCalc();
  return filled;
}

function renderAiSources(sources) {
  const box = $('#aiSources');
  if (!sources.length) { box.hidden = true; return; }
  const label = sources[0].cited ? 'Sources:' : 'Searched:';
  box.replaceChildren(el('span', {}, label),
    ...sources.map((s) => el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title)));
  box.hidden = false;
}

/* =====================================================================
   Free label reading on the device (Tesseract.js text recognition).
   Fills only values with an unambiguous pattern: ABV and volume.
   ===================================================================== */

/** Find ABV and bottle volume in recognised label text. Ambiguous → null. */
function parseLabelText(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const num = (s) => Number(s.replace(',', '.'));
  const N = '(\\d{1,2}(?:[.,]\\d{1,2})?)';
  // ABV only counts when the % is tied to "vol", "alc"/"alk" or "ABV" (not "100% Malt").
  const abvPatterns = [
    new RegExp(N + '\\s*%\\s*(?:vol|alc|alk|abv|by\\s*vol)', 'gi'),
    new RegExp('(?:alc|alk|abv|alcohol|alkohol)\\.?[^0-9%]{0,15}' + N + '\\s*%', 'gi'),
  ];
  const abvs = new Set();
  abvPatterns.forEach((re) => {
    for (const m of t.matchAll(re)) {
      const v = num(m[1]);
      if (v > 0 && v <= 80) abvs.add(v);
    }
  });
  const vols = new Set();
  for (const m of t.matchAll(/(\d{1,4}(?:[.,]\d{1,3})?)\s*(ml|cl|ltr|liter|litre|l)(?![a-z])/gi)) {
    const unit = m[2].toLowerCase();
    const v = num(m[1]);
    const ml = unit === 'ml' ? v : unit === 'cl' ? v * 10 : v * 1000;
    if (ml >= 20 && ml <= 5000) vols.add(Math.round(ml));
  }
  return {
    abv: abvs.size === 1 ? [...abvs][0] : null,
    volumeMl: vols.size === 1 ? [...vols][0] : null,
    conflicting: abvs.size > 1 || vols.size > 1,
  };
}

let ocrBusy = false;
let ocrWorkerPromise = null;
let ocrProgress = null; // set while reading, receives Tesseract progress messages

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`) && window.Tesseract) return resolve();
    const s = el('script', { src });
    s.onload = () => resolve();
    s.onerror = () => { s.remove(); reject(new Error('Text recognition could not be loaded.')); };
    document.head.append(s);
  });
}

function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = loadScript(OCR.script).then(() => window.Tesseract.createWorker('eng', 1, {
      workerPath: OCR.workerPath,
      corePath: OCR.corePath,
      langPath: OCR.langPath,
      logger: (m) => { if (ocrProgress) ocrProgress(m); },
    }));
    ocrWorkerPromise.catch(() => { ocrWorkerPromise = null; }); // allow a retry later
  }
  return ocrWorkerPromise;
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}

function setOcrBusy(busy, label) {
  ocrBusy = busy;
  const b = $('#ocrBtn');
  b.classList.toggle('busy', busy);
  b.textContent = busy ? (label || 'Reading…') : 'Read label (free)';
  updateReadButtons();
}

async function readLabel() {
  if (ocrBusy || aiBusy || !state.formPhoto) return;
  resetAiUi();
  const editingId = state.editingId;
  const photo = state.formPhoto;
  setOcrBusy(true, 'Loading…');
  ocrProgress = (m) => {
    if (m.status === 'recognizing text') $('#ocrBtn').textContent = `Reading… ${Math.round((m.progress || 0) * 100)}%`;
    else if (/loading/.test(m.status || '')) $('#ocrBtn').textContent = 'Loading…';
  };
  try {
    const worker = await withTimeout(getOcrWorker(), 120000, 'Loading text recognition timed out.');
    const { data } = await withTimeout(worker.recognize(photo), 60000, 'Reading the label took too long.');
    if (!$('#drinkDialog').open || state.editingId !== editingId || state.formPhoto !== photo) return;
    const r = parseLabelText(data.text);
    const filled = applyAiSuggestions({
      name: null, brand: null, category: null, abv: r.abv, volumeMl: r.volumeMl, country: null, region: null, description: null,
    });
    const text = (data.text || '').trim();
    if (text) {
      $('#ocrTextBody').textContent = text;
      $('#ocrText').hidden = false;
    }
    let msg = filled.length
      ? `Filled: ${filled.join(', ')}. Please check the highlighted fields.`
      : (r.abv !== null || r.volumeMl !== null
        ? `Found ${[r.abv !== null ? 'ABV' : null, r.volumeMl !== null ? 'volume' : null].filter(Boolean).join(' and ')}, but you had already filled it in – kept yours.`
        : 'No clear ABV or volume found on the label.');
    if (r.conflicting) msg += ' Some values were ambiguous and left empty.';
    if (text) msg += ' Name and producer: copy them from the recognized text below.';
    else msg += ' No text recognized – try a sharper, closer photo of the label.';
    showAiMsg(msg, false);
  } catch (err) {
    showAiMsg(err.message + ' The first use needs an internet connection; after that it works offline.', true);
  } finally {
    ocrProgress = null;
    setOcrBusy(false);
  }
}

/* =====================================================================
   Countries (offline lookup: name, lat, lng, aliases incl. German names)
   ===================================================================== */

const COUNTRIES = [
  ['Argentina', -34, -64, 'argentinien'], ['Armenia', 40.1, 45, 'armenien'],
  ['Australia', -25, 134, 'australien'], ['Austria', 47.5, 14.5, 'österreich,oesterreich'],
  ['Azerbaijan', 40.3, 47.7, 'aserbaidschan'], ['Barbados', 13.2, -59.5, ''],
  ['Belarus', 53.7, 28, 'weißrussland'], ['Belgium', 50.6, 4.6, 'belgien,belgique,belgië'],
  ['Belize', 17.2, -88.7, ''], ['Bolivia', -16.5, -64.7, 'bolivien'],
  ['Bosnia and Herzegovina', 44, 17.8, 'bosnien,bosnien und herzegowina'], ['Brazil', -10, -52, 'brasilien,brasil'],
  ['Bulgaria', 42.7, 25.3, 'bulgarien'], ['Cambodia', 12.6, 104.9, 'kambodscha'],
  ['Canada', 56, -106, 'kanada'], ['Chile', -33, -71, ''],
  ['China', 35, 103, ''], ['Colombia', 4, -73, 'kolumbien'],
  ['Costa Rica', 9.9, -84.1, ''], ['Croatia', 45.1, 15.2, 'kroatien,hrvatska'],
  ['Cuba', 21.5, -79.5, 'kuba'], ['Cyprus', 35, 33, 'zypern'],
  ['Czech Republic', 49.8, 15.5, 'czechia,tschechien,tschechische republik'], ['Denmark', 56, 10, 'dänemark,daenemark,danmark'],
  ['Dominican Republic', 18.9, -70.4, 'dominikanische republik'], ['Ecuador', -1.5, -78.2, ''],
  ['Egypt', 26.8, 30.8, 'ägypten'], ['El Salvador', 13.8, -88.9, ''],
  ['England', 52.5, -1.5, ''], ['Estonia', 58.6, 25, 'estland'],
  ['Ethiopia', 9.1, 40.5, 'äthiopien'], ['Fiji', -17.7, 178, 'fidschi'],
  ['Finland', 62, 26, 'finnland,suomi'], ['France', 46.6, 2.4, 'frankreich'],
  ['Georgia', 42.2, 43.5, 'georgien'], ['Germany', 51.2, 10.4, 'deutschland'],
  ['Ghana', 7.9, -1, ''], ['Greece', 39.1, 22, 'griechenland'],
  ['Guatemala', 15.7, -90.2, ''], ['Guyana', 4.9, -58.9, ''],
  ['Haiti', 19, -72.4, ''], ['Honduras', 14.8, -86.6, ''],
  ['Hungary', 47.2, 19.5, 'ungarn,magyarország'], ['Iceland', 64.9, -18.6, 'island'],
  ['India', 22, 79, 'indien'], ['Indonesia', -2.5, 118, 'indonesien'],
  ['Ireland', 53.2, -8, 'irland,eire,republic of ireland'], ['Israel', 31.4, 35, ''],
  ['Italy', 42.8, 12.6, 'italien,italia'], ['Jamaica', 18.1, -77.3, 'jamaika'],
  ['Japan', 36.2, 138.3, ''], ['Kazakhstan', 48, 67, 'kasachstan'],
  ['Kenya', 0.2, 37.9, 'kenia'], ['Latvia', 56.9, 24.6, 'lettland'],
  ['Lebanon', 33.9, 35.9, 'libanon'], ['Lithuania', 55.2, 23.9, 'litauen'],
  ['Luxembourg', 49.8, 6.1, 'luxemburg'], ['Malta', 35.9, 14.4, ''],
  ['Martinique', 14.6, -61, ''], ['Mauritius', -20.3, 57.6, ''],
  ['Mexico', 23.6, -102.5, 'mexiko,méxico'], ['Moldova', 47.4, 28.4, 'moldawien,moldau'],
  ['Montenegro', 42.7, 19.4, ''], ['Morocco', 31.8, -7.1, 'marokko'],
  ['Netherlands', 52.2, 5.3, 'niederlande,holland,nederland,the netherlands'], ['New Zealand', -41.5, 172.8, 'neuseeland'],
  ['Nicaragua', 12.9, -85.2, ''], ['Nigeria', 9.1, 8.7, ''],
  ['North Macedonia', 41.6, 21.7, 'nordmazedonien,macedonia'], ['Northern Ireland', 54.6, -6.7, 'nordirland'],
  ['Norway', 61, 8.5, 'norwegen,norge'], ['Panama', 8.5, -80.8, ''],
  ['Paraguay', -23.4, -58.4, ''], ['Peru', -9.2, -75, ''],
  ['Philippines', 12.9, 121.8, 'philippinen'], ['Poland', 52, 19.4, 'polen,polska'],
  ['Portugal', 39.6, -8, ''], ['Puerto Rico', 18.2, -66.5, ''],
  ['Romania', 45.9, 25, 'rumänien,rumaenien'], ['Russia', 56, 40, 'russland,russian federation'],
  ['Scotland', 56.8, -4.2, 'schottland'], ['Serbia', 44, 20.9, 'serbien'],
  ['Singapore', 1.35, 103.8, 'singapur'], ['Slovakia', 48.7, 19.7, 'slowakei'],
  ['Slovenia', 46.1, 14.9, 'slowenien'], ['South Africa', -30.6, 22.9, 'südafrika,suedafrika'],
  ['South Korea', 36.5, 127.9, 'korea,südkorea,republic of korea'], ['Spain', 40.2, -3.7, 'spanien,españa,espana'],
  ['Sri Lanka', 7.9, 80.8, ''], ['Sweden', 62, 15, 'schweden,sverige'],
  ['Switzerland', 46.8, 8.2, 'schweiz,suisse,svizzera'], ['Taiwan', 23.7, 121, ''],
  ['Tanzania', -6.4, 34.9, 'tansania'], ['Thailand', 15.9, 100.9, ''],
  ['Trinidad and Tobago', 10.7, -61.2, 'trinidad'], ['Tunisia', 34, 9, 'tunesien'],
  ['Turkey', 39, 35.2, 'türkei,tuerkei,türkiye'], ['Ukraine', 49, 31.4, ''],
  ['United Kingdom', 54, -2.5, 'uk,great britain,britain,großbritannien,grossbritannien,vereinigtes königreich'],
  ['United States', 39.8, -98.6, 'usa,us,u.s.,u.s.a.,united states of america,america,vereinigte staaten'],
  ['Uruguay', -32.5, -55.8, ''], ['Venezuela', 6.4, -66.6, ''],
  ['Vietnam', 14.1, 108.3, 'viet nam'], ['Wales', 52.3, -3.7, ''],
];

const COUNTRY_INDEX = new Map();
COUNTRIES.forEach(([name, lat, lng, aliases]) => {
  const entry = { name, lat, lng };
  [name, ...aliases.split(',')].filter(Boolean).forEach((a) => COUNTRY_INDEX.set(a.toLowerCase(), entry));
});

/** Known country for a typed name (English or German), or null. */
function findCountry(name) {
  if (typeof name !== 'string') return null;
  return COUNTRY_INDEX.get(name.trim().toLowerCase()) || null;
}

/* =====================================================================
   Geocoding (Nominatim) – only for regions/cities and unknown countries.
   The result is cached in the drink record; on failure the map uses
   the country position from the table above.
   ===================================================================== */

/** The place to look up for a drink, or null if the country table is enough. */
function geoQueryFor(d) {
  if (d.region) return d.country ? `${d.region}, ${d.country}` : d.region;
  if (d.country && !findCountry(d.country)) return d.country;
  return null;
}

/** Map position of a drink: cached geocode for its current place, else country table. */
function drinkPosition(d) {
  const q = geoQueryFor(d);
  if (q && d.geoQuery === q && validLatLng(d.lat, d.lng)) {
    return { lat: d.lat, lng: d.lng, key: 'g:' + q.toLowerCase(), label: q, region: Boolean(d.region) };
  }
  const c = findCountry(d.country);
  if (c) return { lat: c.lat, lng: c.lng, key: 'c:' + c.name, label: c.name, region: false };
  return null;
}

/** Group drinks by map position. Returns { groups, without }. */
function groupForMap(drinks) {
  const groups = new Map();
  let without = 0;
  drinks.forEach((d) => {
    const p = drinkPosition(d);
    if (!p) { without++; return; }
    if (!groups.has(p.key)) groups.set(p.key, { key: p.key, label: p.label, lat: p.lat, lng: p.lng, region: p.region, drinks: [] });
    groups.get(p.key).drinks.push(d);
  });
  return { groups: [...groups.values()], without };
}

/** Number of distinct countries (known names count once, whatever language). */
function countCountries(drinks) {
  const set = new Set();
  drinks.forEach((d) => {
    if (!d.country) return;
    const c = findCountry(d.country);
    set.add(c ? c.name : d.country.trim().toLowerCase());
  });
  return set.size;
}

let lastGeocodeAt = 0;

async function nominatim(query) {
  // Nominatim usage policy: at most one request per second.
  const wait = lastGeocodeAt + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeocodeAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(query),
      { signal: controller.signal, headers: { 'Accept-Language': 'en' } });
    if (!res.ok) return null;
    const list = await res.json();
    const lat = Number(list[0] && list[0].lat);
    const lng = Number(list[0] && list[0].lon);
    return validLatLng(lat, lng) ? { lat, lng } : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Look up the drink's region (if needed) and cache the position in the record. */
async function geocodeDrink(id) {
  const d = state.drinks.find((x) => x.id === id);
  if (!d) return;
  const q = geoQueryFor(d);
  if (!q) {
    if (d.lat === null && d.geoQuery === null) return;
    return storeGeo(id, null, null, null);
  }
  if (q === d.geoQuery && validLatLng(d.lat, d.lng)) return; // already up to date
  const pos = await nominatim(q);
  if (pos) await storeGeo(id, pos.lat, pos.lng, q);
}

async function storeGeo(id, lat, lng, geoQuery) {
  const d = state.drinks.find((x) => x.id === id);
  if (!d) return;
  const updated = Object.assign({}, d, { lat, lng, geoQuery });
  try { await putAll('drinks', [updated]); } catch (e) { return; }
  state.drinks = state.drinks.map((x) => (x.id === id ? updated : x));
  if (state.view === 'map') renderMap();
  queueSync({ drinkIds: [id] });
}

let geocodingAll = false;

/** When the map opens, look up regions that were never geocoded (e.g. after an import). */
async function geocodeMissing() {
  if (geocodingAll || !navigator.onLine) return;
  geocodingAll = true;
  try {
    const todo = state.drinks.filter((d) => {
      const q = geoQueryFor(d);
      return q && !(q === d.geoQuery && validLatLng(d.lat, d.lng));
    });
    for (const d of todo.slice(0, 20)) await geocodeDrink(d.id);
  } finally {
    geocodingAll = false;
  }
}

/* =====================================================================
   Map (Leaflet + OpenStreetMap, loaded from a CDN on first use)
   ===================================================================== */

let map = null;
let mapLayer = null;
let leafletPromise = null;
let mapNeedsFit = true;

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletPromise) {
    leafletPromise = new Promise((resolve, reject) => {
      const css = el('link', { rel: 'stylesheet', href: LEAFLET_URL + 'leaflet.css' });
      const js = el('script', { src: LEAFLET_URL + 'leaflet.js' });
      js.onload = () => resolve(window.L);
      js.onerror = () => { leafletPromise = null; reject(new Error('Map library could not be loaded.')); };
      document.head.append(css, js);
    });
  }
  return leafletPromise;
}

async function openMapView() {
  renderMapChips();
  renderMapStats();
  let L;
  try {
    L = await loadLeaflet();
  } catch (e) {
    $('#mapMsg').textContent = 'The map needs an internet connection. Your data is fine – try again when online.';
    return;
  }
  if (!map) {
    map = L.map('map', { worldCopyJump: true, zoomControl: true }).setView([30, 10], 2);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    mapLayer = L.layerGroup().addTo(map);
  }
  map.invalidateSize();
  mapNeedsFit = true;
  renderMap();
  geocodeMissing();
}

function mapDrinks() {
  return state.mapTab === ALL ? state.drinks : state.drinks.filter((d) => d.tabId === state.mapTab);
}

function renderMapChips() {
  const make = (id, name) => {
    const b = el('button', { type: 'button', class: 'pill', 'aria-pressed': String(state.mapTab === id) }, name);
    b.addEventListener('click', () => { state.mapTab = id; mapNeedsFit = true; renderMapChips(); renderMap(); });
    return b;
  };
  $('#mapChips').replaceChildren(make(ALL, 'All'), ...state.tabs.map((t) => make(t.id, t.name)));
}

function renderMapStats() {
  const n = countCountries(state.drinks);
  $('#mapStats').textContent = `${n} ${n === 1 ? 'country' : 'countries'} visited`;
}

function renderMap() {
  renderMapStats();
  if (!state.tabs.some((t) => t.id === state.mapTab)) state.mapTab = ALL;
  const drinks = mapDrinks();
  const { groups, without } = groupForMap(drinks);
  $('#mapMsg').textContent = [
    `${drinks.length - without} drink${drinks.length - without === 1 ? '' : 's'} on the map`,
    without ? `${without} without origin (add a country to show them)` : '',
  ].filter(Boolean).join(' · ');
  if (!map || !window.L) return;
  const L = window.L;
  mapLayer.clearLayers();
  groups.forEach((g) => {
    const icon = L.divIcon({
      className: '',
      html: `<div class="map-pin${g.region ? ' region' : ''}">${g.drinks.length}</div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
    L.marker([g.lat, g.lng], { icon, title: g.label, keyboard: true })
      .on('click', () => showGroup(g))
      .addTo(mapLayer);
  });
  if (mapNeedsFit) {
    mapNeedsFit = false;
    if (groups.length) map.fitBounds(groups.map((g) => [g.lat, g.lng]), { padding: [40, 40], maxZoom: 6 });
    else map.setView([30, 10], 2);
  }
}

/** Sheet listing the drinks of one map pin. */
function showGroup(g) {
  $('#groupTitle').textContent = g.label;
  $('#groupList').replaceChildren(...g.drinks
    .slice().sort((a, b) => b.rating - a.rating)
    .map((d) => el('li', {}, el('button', { type: 'button', class: 'frow link-row', 'data-id': d.id },
      el('span', { class: 'row-main' }, d.name, el('div', { class: 'row-sub' }, [tabName(d.tabId), d.brand].filter(Boolean).join(' · '))),
      el('span', { class: 'rating-badge' }, String(d.rating)),
      el('span', { class: 'chev', 'aria-hidden': 'true' })))));
  $('#groupDialog').showModal();
}

/* =====================================================================
   PWA: offline app shell (only over https or localhost)
   ===================================================================== */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  navigator.serviceWorker.register('sw.js').catch(() => { /* app works without it */ });
}

/* ---------- Boot ---------- */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseNumber, roundMoney, toLiters, calcPrices, validateDrink, applyView, pickBestValue, validateTabName, parseBackup, fallbackTabId, gitBlobSha, bytesToBase64, drinkToRemote,
    sanitizeAiResult, extractJson, parseLabelText, findCountry, drinkPosition, groupForMap, countCountries, geoQueryFor, AI_MODEL };
}
if (typeof document !== 'undefined') init();
