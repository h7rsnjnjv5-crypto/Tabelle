/* Drink Tracker – vanilla JS, all data stored locally in IndexedDB. */
'use strict';

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
    },
  };
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
    };
    const { errors, values } = validateDrink(raw);
    const keys = Object.keys(errors);
    if (keys.length) throw new Error(`Drink #${i + 1} (“${d.name || '?'}”): ${errors[keys[0]]}`);
    const isImg = (s) => typeof s === 'string' && s.startsWith('data:image/');
    return Object.assign(values, {
      id: typeof d.id === 'string' && d.id ? d.id : uid(),
      photo: isImg(d.photo) ? d.photo : null,
      thumb: isImg(d.thumb) ? d.thumb : (isImg(d.photo) ? d.photo : null),
      createdAt: Number.isFinite(d.createdAt) ? d.createdAt : Date.now(),
      updatedAt: Number.isFinite(d.updatedAt) ? d.updatedAt : Date.now(),
    });
  });

  const currency = data.settings && typeof data.settings.currency === 'string' && data.settings.currency.trim()
    ? data.settings.currency.trim().slice(0, 5) : '€';
  return { tabs, drinks, settings: { currency } };
}

/* =====================================================================
   IndexedDB layer
   ===================================================================== */

const DB_NAME = 'drink-tracker';
const DB_VERSION = 1;
let db = null;

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('IndexedDB is not available in this browser.'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('tabs')) d.createObjectStore('tabs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('drinks')) d.createObjectStore('drinks', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database is blocked by another open tab. Close other tabs and reload.'));
  });
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
  } catch (err) {
    document.body.prepend(el('p', { class: 'err' }, 'Could not open local storage: ' + err.message));
    return;
  }
  // Ask the browser not to evict our data under storage pressure.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  buildStaticUi();
  bindEvents();
  renderAll();
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
  state.drinks = drinks;
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
}

function bindEvents() {
  $('#addBtn').addEventListener('click', () => openDrinkDialog(null));
  $('#settingsBtn').addEventListener('click', openSettings);

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
}

function renderTabs() {
  const nav = $('#tabs');
  const counts = {};
  state.drinks.forEach((d) => { counts[d.tabId] = (counts[d.tabId] || 0) + 1; });
  const make = (id, name, count) => {
    const b = el('button', { type: 'button', class: 'tab', 'aria-pressed': String(state.tab === id) },
      name, el('span', { class: 'count' }, String(count)));
    b.addEventListener('click', () => { state.tab = id; renderAll(); });
    return b;
  };
  const edit = el('button', { type: 'button', class: 'tab edit' }, '✎ Edit tabs');
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
  $('#list').replaceChildren(...rows.map((d) => drinkCard(d, d.id === bestId)));
  $('#empty').hidden = rows.length > 0;
  $('#summary').textContent = `${rows.length} of ${state.drinks.length} drink${state.drinks.length === 1 ? '' : 's'}`
    + (bestId ? ' · Best value = highest rating per price per liter' : '');
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

function drinkCard(d, isBest) {
  const card = el('article', { class: 'card' + (isBest ? ' best' : ''), tabindex: '0', 'aria-label': `Edit ${d.name}` });

  let thumb;
  if (d.thumb) {
    thumb = el('button', { type: 'button', class: 'thumb', 'aria-label': `Show photo of ${d.name}` },
      el('img', { src: thumbUrl(d), alt: '', loading: 'lazy' }));
    thumb.addEventListener('click', (e) => { e.stopPropagation(); showImage(d); });
  } else {
    thumb = el('div', { class: 'thumb', 'aria-hidden': 'true' }, '🍷');
  }

  const sub = [tabName(d.tabId), d.brand].filter(Boolean).join(' · ');
  const details = [
    d.volume ? `${NUM.format(d.volume)} ${d.volumeUnit}` : null,
    d.abv !== null && d.abv !== undefined ? `${NUM.format(d.abv)} %` : null,
  ].filter(Boolean).join(' · ');

  const stat = (label, value) => el('div', {}, el('dt', {}, label), el('dd', {}, value));
  card.append(thumb, el('div', { class: 'info' },
    el('h3', {}, d.name, isBest ? el('span', { class: 'badge' }, 'Best value') : null),
    el('p', { class: 'meta' }, sub + (details ? ` · ${details}` : '')),
    el('div', { class: 'stars-small', 'aria-label': `Rating ${d.rating} of 10` },
      '★', el('span', { class: 'num' }, `${d.rating}/10`)),
    el('dl', { class: 'prices' },
      stat('Price', money(d.price)),
      stat('Per liter', money(d.perLiter)),
      stat('Per liter alc.', money(d.perAlcoholLiter)))));

  card.addEventListener('click', () => openDrinkDialog(d.id));
  card.addEventListener('keydown', (e) => {
    if (e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDrinkDialog(d.id); }
  });
  return card;
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
  $('#drinkTitle').textContent = d ? 'Edit drink' : 'Add drink';
  fillCategorySelect($('#fCategory'), d ? d.tabId : (state.tab !== ALL ? state.tab : state.tabs[0].id));
  const str = (v) => (v === null || v === undefined ? '' : String(v));
  $('#fName').value = d ? d.name : '';
  $('#fBrand').value = d ? d.brand : '';
  $('#fNotes').value = d ? d.notes : '';
  $('#fPrice').value = d && d.price !== null ? d.price.toFixed(2) : '';
  $('#fVolume').value = d ? str(d.volume) : '';
  $('#fUnit').value = d ? d.volumeUnit : 'ml';
  $('#fAbv').value = d ? str(d.abv) : '';
  setRating(d ? d.rating : 0);
  state.formPhoto = d ? d.photo || null : null;
  state.formThumb = d ? d.thumb || null : null;
  renderPhotoPreview();
  $('#deleteDrinkBtn').hidden = !d;
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
}

async function deleteDrink() {
  const d = state.drinks.find((x) => x.id === state.editingId);
  if (!d || !confirm(`Delete “${d.name}”? This cannot be undone.`)) return;
  try {
    await deleteKey('drinks', d.id);
  } catch (err) {
    alert('Could not delete: ' + err.message);
    return;
  }
  state.drinks = state.drinks.filter((x) => x.id !== d.id);
  $('#drinkDialog').close();
  renderAll();
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
    const input = el('input', { type: 'text', maxlength: '30', value: t.name, 'aria-label': `Rename ${t.name}` });
    input.addEventListener('change', () => renameTab(t.id, input));
    const del = el('button', { type: 'button', class: 'btn ghost danger', 'aria-label': `Delete ${t.name}` }, 'Delete');
    del.addEventListener('click', () => openDeleteTab(t.id));
    return el('li', {}, input, el('span', { class: 'count' }, `${counts[t.id] || 0}`), del);
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
}

function openDeleteTab(id) {
  if (state.tabs.length <= 1) {
    $('#tabError').textContent = 'You need at least one tab.';
    return;
  }
  const tab = state.tabs.find((t) => t.id === id);
  const count = state.drinks.filter((d) => d.tabId === id).length;
  state.deletingTabId = id;
  $('#delTabText').textContent = count
    ? `“${tab.name}” contains ${count} drink${count === 1 ? '' : 's'}. They will be moved to another tab, not deleted.`
    : `Delete the empty tab “${tab.name}”?`;
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
}

/* ---------- Settings, export, import ---------- */

function openSettings() {
  $('#currency').value = state.settings.currency;
  $('#settingsDialog').showModal();
}

async function saveCurrency() {
  const value = $('#currency').value.trim().slice(0, 5) || '€';
  $('#currency').value = value;
  try { await putAll('meta', [{ key: 'settings', currency: value }]); } catch (e) { alert('Could not save: ' + e.message); return; }
  state.settings.currency = value;
  renderList();
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
    // Convert photos before opening the transaction (it must not wait on async work).
    parsed.drinks.forEach((d) => {
      d.photo = d.photo ? dataUrlToBlob(d.photo) : null;
      d.thumb = d.thumb ? dataUrlToBlob(d.thumb) : null;
    });
    const t = db.transaction(['tabs', 'drinks', 'meta'], 'readwrite');
    ['tabs', 'drinks', 'meta'].forEach((s) => t.objectStore(s).clear());
    parsed.tabs.forEach((x) => t.objectStore('tabs').put(x));
    parsed.drinks.forEach((x) => t.objectStore('drinks').put(x));
    t.objectStore('meta').put({ key: 'settings', currency: parsed.settings.currency });
    await txDone(t);
    await loadAll();
  } catch (err) {
    alert('Import failed, nothing was changed: ' + err.message);
    return;
  }
  state.tab = ALL;
  $('#settingsDialog').close();
  renderAll();
  alert('Import complete.');
}

/* ---------- Boot ---------- */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseNumber, roundMoney, toLiters, calcPrices, validateDrink, applyView, pickBestValue, validateTabName, parseBackup, fallbackTabId };
}
if (typeof document !== 'undefined') init();
