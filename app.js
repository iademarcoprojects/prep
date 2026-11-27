/* Prep Inventory - phone app. Talks to the Apps Script back end, which reads/writes the Google Sheet. */
'use strict';
const VERSION = '0.2.1';
const FOOD_CATEGORIES = ['Grain / starch', 'Protein', 'Dairy', 'Fat / spread', 'Vegetable', 'Fruit',
  'Snack', 'Soup / meal', 'Sweetener / other', 'Child favorite'];

const $ = (id) => document.getElementById(id);
const state = { supplies: [], foods: [], loadedAt: null };
let scanner = null;

// ------------------------------------------------------------ settings & storage
function cfg() {
  try { return JSON.parse(localStorage.getItem('prepCfg') || '{}'); } catch (e) { return {}; }
}
function saveCfg(c) { try { localStorage.setItem('prepCfg', JSON.stringify(c)); } catch (e) {} }
function cacheData() {
  try { localStorage.setItem('prepData', JSON.stringify(state)); } catch (e) {}
}
function loadCachedData() {
  try { Object.assign(state, JSON.parse(localStorage.getItem('prepData') || '{}')); } catch (e) {}
}

// ------------------------------------------------------------ back end
async function api(action, body) {
  const c = cfg();
  if (!c.url || !c.code) throw new Error('Open Settings and enter the back-end URL and access code.');
  // text/plain avoids a browser pre-check that Apps Script does not answer
  const res = await fetch(c.url, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ action: action, code: c.code, who: c.who || '' }, body || {}))
  });
  if (!res.ok) throw new Error('Back end returned HTTP ' + res.status);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Unknown error');
  return data;
}
async function refresh(quiet) {
  try {
    $('sync').textContent = 'loading...';
    const d = await api('list');
    state.supplies = d.supplies; state.foods = d.foods; state.loadedAt = new Date().toISOString();
    cacheData(); renderSupplies(); renderFoods(); fillCategories();
    $('sync').textContent = 'updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch (e) {
    $('sync').textContent = state.loadedAt ? 'offline copy' : 'not loaded';
    if (!quiet) toast(e.message);
  }
}

// ------------------------------------------------------------ UI helpers
function toast(msg, ms) {
  const t = $('toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.style.display = 'none'; }, ms || 3500);
}
function el(tag, attrs, children) {
  const e = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (k === 'text') e.textContent = v;
    else if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  });
  (children || []).forEach(ch => ch && e.appendChild(ch));
  return e;
}
function fmt(n) { return n === null || n === undefined || n === '' ? '-' : Number(n).toLocaleString(); }
function show(view) {
  document.querySelectorAll('main > section').forEach(s => s.classList.add('hidden'));
  $('view-' + view).classList.remove('hidden');
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  if (view !== 'scan') stopScan();
}
function openPanel(nodes) {
  const p = $('panel'); p.innerHTML = ''; nodes.forEach(n => p.appendChild(n));
  $('sheet').style.display = 'block';
}
function closePanel() { $('sheet').style.display = 'none'; }
$('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closePanel(); });

// ------------------------------------------------------------ count editor (shared)
function countEditor(tab, rec, title, onDone) {
  const qty = el('input', { type: 'number', inputmode: 'decimal', value: '1', min: '0' });
  const step = (d) => { qty.value = Math.max(0, (Number(qty.value) || 0) + d); };
  const send = async (mode, sign) => {
    const q = Number(qty.value);
    if (isNaN(q) || q < 0) return toast('Enter a quantity of zero or more.');
    btns.forEach(b => b.disabled = true);
    try {
      const r = await api('adjust', { tab: tab, id: rec.id, mode: mode, qty: mode === 'set' ? q : sign * q });
      rec.owned = r.owned;
      toast((mode === 'set' ? 'Set ' : sign > 0 ? 'Added. ' : 'Removed. ') + title + ': now ' + fmt(r.owned));
      closePanel(); if (onDone) onDone(); refresh(true);
    } catch (e) { toast(e.message); btns.forEach(b => b.disabled = false); }
  };
  const btns = [
    el('button', { class: 'btn green', text: 'Add', onclick: () => send('add', 1) }),
    el('button', { class: 'btn red', text: 'Remove', onclick: () => send('add', -1) }),
    el('button', { class: 'btn', text: 'Set count', onclick: () => send('set', 1) })
  ];
  return el('div', {}, [
    el('h2', { text: title }),
    el('div', { class: 'meta', text: 'Owned now: ' + fmt(rec.owned) + (rec.target !== null && rec.target !== undefined ? '   Target: ' + fmt(rec.target) : '') + (rec.unit ? '   Unit: ' + rec.unit : '') }),
    el('label', { text: 'Quantity' }),
    el('div', { class: 'stepper' }, [
      el('button', { class: 'btn alt', text: '-', onclick: () => step(-1) }), qty,
      el('button', { class: 'btn alt', text: '+', onclick: () => step(1) })
    ]),
    el('div', { class: 'qtyrow' }, btns),
    el('p', { class: 'small', text: '"Set count" replaces the total (use it when counting what you have). Add and Remove change it (use them for purchases and use).' }),
    el('button', { class: 'btn alt', text: 'Cancel', style: 'width:100%;margin-top:6px', onclick: () => { closePanel(); if (onDone) onDone(); } })
  ]);
}

// ------------------------------------------------------------ supplies & food lists
function fillCategories() {
  const sel = $('supCat'); const cur = sel.value;
  const cats = [...new Set(state.supplies.map(s => s.category))];
  sel.innerHTML = ''; sel.appendChild(el('option', { value: '', text: 'All categories' }));
  cats.forEach(c => sel.appendChild(el('option', { value: c, text: c })));
  sel.value = cur;
}
function renderSupplies() {
  const q = $('supSearch').value.trim().toLowerCase(), cat = $('supCat').value, st = $('supStatus').value;
  const list = $('supList'); list.innerHTML = '';
  const rows = state.supplies.filter(s => (!q || (s.item + ' ' + s.notes).toLowerCase().includes(q)) &&
    (!cat || s.category === cat) && (!st || s.status === st));
  if (!rows.length) list.appendChild(el('div', { class: 'small', text: state.loadedAt ? 'No matching items.' : 'Not loaded yet. Check Settings.' }));
  rows.forEach(s => {
    list.appendChild(el('div', { class: 'item', onclick: () => {
      if (s.formulaOwned) return toast('This total is calculated from the Food tab. Update the foods instead.');
      openPanel([countEditor('supplies', s, s.item)]);
    } }, [
      el('div', { class: 'name' }, [document.createTextNode(s.item), el('span', { class: 'pill s-' + String(s.status).replace(/\s/g, ''), text: s.status })]),
      el('div', { class: 'meta', text: s.category + '  |  owned ' + fmt(s.owned) + ' of ' + fmt(s.target) + ' ' + (s.unit || '') + (s.location ? '  |  ' + s.location : '') })
    ]));
  });
}
// Same rules as the Supplies status: no target -> no label; not counted; short; complete.
function foodStatus(f) {
  if (f.target === null || f.target === undefined) return '';
  if (f.owned === null || f.owned === undefined) return 'Not counted';
  return f.owned >= f.target ? 'Complete' : 'Short';
}
function renderFoods() {
  const q = $('foodSearch').value.trim().toLowerCase();
  const list = $('foodList'); list.innerHTML = '';
  const rows = state.foods.filter(f => !q || f.name.toLowerCase().includes(q));
  if (!rows.length) list.appendChild(el('div', { class: 'small', text: state.loadedAt ? 'No matching foods.' : 'Not loaded yet. Check Settings.' }));
  rows.forEach(f => list.appendChild(el('div', { class: 'item', onclick: () => openPanel([countEditor('food', f, f.name)]) }, [
    el('div', { class: 'name' }, [document.createTextNode(f.name), (() => {
      const st = foodStatus(f);
      return st ? el('span', { class: 'pill s-' + st.replace(/\s/g, ''), text: st }) : null;
    })()]),
    el('div', { class: 'meta', text: 'owned ' + fmt(f.owned) + ' of ' + fmt(f.target) + ' ' + (f.unit || '') +
      '  |  ' + fmt(f.kcal) + ' kcal, ' + fmt(f.protein) + ' g protein per unit' + (f.barcodes.length ? '  |  ' + f.barcodes.length + ' barcode(s)' : '') })
  ])));
}

// ------------------------------------------------------------ barcode scanning
function normalizeCode(raw) {
  let c = String(raw || '').replace(/\D/g, '');
  if (c.length === 12) c = '0' + c;          // UPC-A -> EAN-13 so both scanners agree
  return c;
}
async function startScan() {
  if (typeof Html5Qrcode === 'undefined') return toast('Scanner library did not load. Check the internet connection and reopen the app.');
  $('reader').classList.remove('hidden'); $('btnStop').classList.remove('hidden'); $('btnScan').classList.add('hidden');
  $('scanResult').innerHTML = '';
  const F = Html5QrcodeSupportedFormats;
  scanner = new Html5Qrcode('reader', {
    formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128],
    experimentalFeatures: { useBarCodeDetectorIfSupported: true }, verbose: false
  });
  // Higher camera resolution, continuous focus and a large scan area help the
  // browser-based reader that iPhones use (Android uses the phone's built-in reader).
  const config = {
    fps: 15, disableFlip: true,
    qrbox: (w, h) => ({ width: Math.floor(w * 0.92), height: Math.max(120, Math.floor(h * 0.5)) }),
    videoConstraints: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 },
                        advanced: [{ focusMode: 'continuous' }] }
  };
  const onHit = (text) => { stopScan(); if (navigator.vibrate) navigator.vibrate(80); handleCode(text); };
  try {
    await scanner.start({ facingMode: 'environment' }, config, onHit, () => {});
  } catch (e) {
    // some phones refuse the high-resolution request: retry with plain settings
    try { await scanner.start({ facingMode: 'environment' }, { fps: 15, qrbox: config.qrbox, disableFlip: true }, onHit, () => {}); }
    catch (e2) {
      stopScan();
      toast('Camera could not start: ' + (e2 && e2.message ? e2.message : e2) + '. Check camera permission, or use "Take a photo instead".', 6000);
    }
  }
}
// Fallback: decode a still photo. A full-resolution photo is much easier to read than live video.
async function scanPhoto(file) {
  if (!file) return;
  if (typeof Html5Qrcode === 'undefined') return toast('Scanner library did not load. Check the internet connection and reopen the app.');
  await stopScan();
  const F = Html5QrcodeSupportedFormats;
  const reader = new Html5Qrcode('photoReader', { formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128], verbose: false });
  toast('Reading photo...', 2000);
  try { const text = await reader.scanFile(file, false); handleCode(text); }
  catch (e) { toast('No barcode found in the photo. Fill the frame with the barcode, hold it level, and try again, or type the number.', 6000); }
  finally { try { reader.clear(); } catch (e) {} $('photoInput').value = ''; }
}
async function stopScan() {
  $('reader').classList.add('hidden'); $('btnStop').classList.add('hidden'); $('btnScan').classList.remove('hidden');
  if (scanner) { const s = scanner; scanner = null; try { await s.stop(); s.clear(); } catch (e) {} }
}
async function handleCode(raw) {
  const code = normalizeCode(raw);
  const out = $('scanResult'); out.innerHTML = '';
  if (code.length < 6) return toast('That does not look like a product barcode.');
  out.appendChild(el('div', { class: 'card small', text: 'Barcode ' + code + ': looking up...' }));
  let known = null;
  try { known = (await api('lookup', { barcode: code })).food; }
  catch (e) { out.innerHTML = ''; return toast(e.message); }
  out.innerHTML = '';
  if (known) {
    out.appendChild(el('div', { class: 'card' }, [countEditor('food', known, known.name, () => { $('scanResult').innerHTML = ''; })]));
    // countEditor closes the bottom panel on success; here it is inline, so also clear the card
    return;
  }
  // unknown barcode: try Open Food Facts for a name and nutrition
  const card = el('div', { class: 'card' }, [el('div', { class: 'small', text: 'New barcode ' + code + '. Checking Open Food Facts...' })]);
  out.appendChild(card);
  const off = await openFoodFacts(code);
  card.innerHTML = '';
  card.appendChild(newProductForm(code, off));
}
async function openFoodFacts(code) {
  try {
    const r = await fetch('https://world.openfoodfacts.org/api/v2/product/' + code +
      '.json?fields=product_name,brands,quantity,product_quantity,nutriments');
    const d = await r.json();
    if (d.status !== 1 || !d.product) return null;
    const p = d.product, n = p.nutriments || {}, grams = Number(p.product_quantity);
    const per = (k) => (n[k + '_100g'] !== undefined && grams > 0) ? Math.round(Number(n[k + '_100g']) * grams / 100) : '';
    return { name: [p.brands && p.brands.split(',')[0], p.product_name].filter(Boolean).join(' '),
             unit: p.quantity || '', kcal: per('energy-kcal'), protein: per('proteins') };
  } catch (e) { return null; }
}
function newProductForm(code, off) {
  const linkSel = el('select', {}, [el('option', { value: '', text: 'Choose an existing food...' })]);
  state.foods.forEach(f => linkSel.appendChild(el('option', { value: f.id, text: f.name + (f.unit ? ' (' + f.unit + ')' : '') })));
  const name = el('input', { value: off ? off.name : '' });
  const cat = el('select', {}, FOOD_CATEGORIES.map(c => el('option', { value: c, text: c })));
  const unit = el('input', { value: off ? off.unit : '', placeholder: 'e.g. 15 oz can' });
  const kcal = el('input', { type: 'number', inputmode: 'decimal', value: off ? off.kcal : '' });
  const prot = el('input', { type: 'number', inputmode: 'decimal', value: off ? off.protein : '' });
  const done = (food) => {
    const rec = state.foods.find(f => f.id === food.id) || { id: food.id, name: food.name, owned: null, target: null };
    $('scanResult').innerHTML = '';
    $('scanResult').appendChild(el('div', { class: 'card' }, [countEditor('food', rec, rec.name, () => { $('scanResult').innerHTML = ''; })]));
  };
  return el('div', {}, [
    el('h2', { text: 'New barcode: ' + code }),
    el('p', { class: 'small', text: off ? 'Found on Open Food Facts. Check the name and numbers against the package label.' :
      'Not found on Open Food Facts. Link it to a food you already track, or enter it from the label.' }),
    el('label', { text: 'Option 1: same kind of food you already track (for example another brand of canned beans)' }),
    linkSel,
    el('button', { class: 'btn', text: 'Link barcode to this food', style: 'width:100%;margin-top:8px', onclick: async (e) => {
      if (!linkSel.value) return toast('Choose a food first.');
      e.target.disabled = true;
      try { const r = await api('linkBarcode', { id: linkSel.value, barcode: code }); await refresh(true); done(r.food); }
      catch (err) { toast(err.message); e.target.disabled = false; }
    } }),
    el('label', { text: 'Option 2: add as a new food' }),
    el('label', { text: 'Name' }), name,
    el('label', { text: 'Category' }), cat,
    el('label', { text: 'Unit (package)' }), unit,
    el('label', { text: 'Calories per package' }), kcal,
    el('label', { text: 'Protein grams per package' }), prot,
    el('p', { class: 'small', text: 'Per package, not per serving: servings per container x calories per serving. Leave blank if unknown.' }),
    el('button', { class: 'btn green', text: 'Add new food', style: 'width:100%;margin-top:4px', onclick: async (e) => {
      if (!name.value.trim()) return toast('Enter a name.');
      e.target.disabled = true;
      try {
        const r = await api('addFood', { barcode: code, name: name.value.trim(), category: cat.value, unit: unit.value.trim(),
          kcal: kcal.value, protein: prot.value, source: off ? 'Open Food Facts - check label' : 'Entered from label in app' });
        await refresh(true); done(r.food);
      } catch (err) { toast(err.message); e.target.disabled = false; }
    } })
  ]);
}

// ------------------------------------------------------------ settings screen
function loadSettingsForm() {
  const c = cfg(); $('setUrl').value = c.url || ''; $('setCode').value = c.code || ''; $('setWho').value = c.who || '';
  $('ver').textContent = VERSION;
}
$('btnSave').addEventListener('click', async () => {
  saveCfg({ url: $('setUrl').value.trim(), code: $('setCode').value.trim(), who: $('setWho').value.trim() });
  $('setMsg').textContent = 'Testing...';
  try { const d = await api('ping'); $('setMsg').textContent = 'Connected to "' + d.title + '".'; refresh(); }
  catch (e) { $('setMsg').textContent = 'Not connected: ' + e.message; }
});

// ------------------------------------------------------------ wiring
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));
$('btnScan').addEventListener('click', startScan);
$('btnStop').addEventListener('click', stopScan);
$('btnPhoto').addEventListener('click', () => $('photoInput').click());
$('photoInput').addEventListener('change', (e) => scanPhoto(e.target.files[0]));
$('btnManual').addEventListener('click', () => handleCode($('manualCode').value));
['supSearch', 'supCat', 'supStatus'].forEach(id => $(id).addEventListener('input', renderSupplies));
$('foodSearch').addEventListener('input', renderFoods);

loadCachedData(); loadSettingsForm(); fillCategories(); renderSupplies(); renderFoods();
if (cfg().url) refresh(true); else show('settings');
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
