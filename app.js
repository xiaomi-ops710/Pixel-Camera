'use strict';
/* =====================================================================
   無音カメラ  —  シャッター音ゼロ / 原寸フレーム書き出し / PWA
   ・getUserMedia のライブ映像から canvas で直接静止画を切り出す
     (OSの撮影API=シャッター音は一切使わない)
   ・音声系API(AudioContext/Audio/Vibrate)は未使用
   ===================================================================== */

/* ---------- ユーティリティ ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pad = (n, l = 2) => String(n).padStart(l, '0');
const fmtBytes = b => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB';
const fmtDur = s => `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`;
const stamp = ts => { const d = new Date(ts); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${pad(d.getMilliseconds(), 3)}`; };
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const show = el => { clearTimeout(el._t); el.classList.remove('closing'); el.hidden = false; void el.offsetWidth; el.classList.add('open'); };
const hide = el => { if (el.hidden) return; el.classList.remove('open'); el.classList.add('closing'); clearTimeout(el._t); el._t = setTimeout(() => { el.classList.remove('closing'); el.hidden = true; }, 240); };
const reduceMotion = () => !cfg.anim || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

/* ---------- 設定 ---------- */
const DEF = {
  photoRes: 'max', fmt: 'jpeg', quality: 0.97, zoomOut: 'crop',
  videoRes: '2160', fps: 30, audio: false,
  burstInterval: 0, burstMax: 60,
  grid: false, level: false, flash: true, mirror: false,
  timer: 0, burstMode: false, facing: 'environment', mode: 'photo',
  prefix: 'IMG', enhance: false, enhMode: 'levels', steady: false, dim: 0, anim: true
};
let cfg = { ...DEF };
try { Object.assign(cfg, JSON.parse(localStorage.getItem('silentcam-cfg') || '{}')); } catch (_) {}
const saveCfg = () => { try { localStorage.setItem('silentcam-cfg', JSON.stringify(cfg)); } catch (_) {} };

/* ---------- トースト / ダイアログ ---------- */
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.firstElementChild.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}
/* マテリアル風リップル(ボタン押下時の波紋) */
document.addEventListener('pointerdown', e => {
  const b = e.target.closest && e.target.closest('.ib,.btn,.mode,.fchip,.seg button');
  if (!b || reduceMotion()) return;
  const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height) * 2;
  const el = document.createElement('span'); el.className = 'ripple';
  el.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
  b.appendChild(el); setTimeout(() => el.remove(), 650);
}, { passive: true });
function dialog({ title, text, ok = 'OK', cancel = 'キャンセル', onOk }) {
  return new Promise(res => {
    $('#dlg-title').textContent = title; $('#dlg-text').textContent = text;
    $('#dlg-ok').textContent = ok; $('#dlg-cancel').textContent = cancel;
    $('#dlg-cancel').hidden = !cancel;
    const d = $('#dlg'); show(d);
    const done = v => { hide(d); $('#dlg-ok').onclick = $('#dlg-cancel').onclick = null; res(v); };
    $('#dlg-ok').onclick = () => { if (onOk) onOk(); done(true); };   // onOk はユーザー操作の同期内で実行
    $('#dlg-cancel').onclick = () => done(false);
  });
}

/* ---------- IndexedDB(メタ+サムネ / 本体Blob を分離) ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('silentcam', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('meta', { keyPath: 'id', autoIncrement: true });
        r.result.createObjectStore('blobs', { keyPath: 'id' });
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  add(meta, blob) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(['meta', 'blobs'], 'readwrite');
      const rq = t.objectStore('meta').add(meta);
      rq.onsuccess = () => { meta.id = rq.result; t.objectStore('blobs').put({ id: rq.result, blob }); };
      t.oncomplete = () => res(meta);
      t.onerror = t.onabort = () => rej(t.error || new Error('保存に失敗'));
    });
  },
  put(meta) {
    return new Promise((res, rej) => {
      const t = this.db.transaction('meta', 'readwrite'); t.objectStore('meta').put(meta);
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    });
  },
  list() {
    return new Promise((res, rej) => {
      const r = this.db.transaction('meta').objectStore('meta').getAll();
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  blob(id) {
    return new Promise((res, rej) => {
      const r = this.db.transaction('blobs').objectStore('blobs').get(id);
      r.onsuccess = () => res(r.result && r.result.blob); r.onerror = () => rej(r.error);
    });
  },
  del(ids) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(['meta', 'blobs'], 'readwrite');
      ids.forEach(id => { t.objectStore('meta').delete(id); t.objectStore('blobs').delete(id); });
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    });
  },
  clear() {
    return new Promise((res, rej) => {
      const t = this.db.transaction(['meta', 'blobs'], 'readwrite');
      t.objectStore('meta').clear(); t.objectStore('blobs').clear();
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    });
  }
};

/* =====================================================================
   カメラ
   ===================================================================== */
const app = $('#app'), stage = $('#stage'), viewport = $('#viewport'), zoomer = $('#zoomer'), video = $('#video');
let stream = null, track = null, hwZoom = false;
let zmin = 1, zmax = 10, zoom = 1, fx = .5, fy = .5;
let recording = false, burstRunning = false, countdownTimer = null;
let startingCamera = null;

const isVideoMode = () => cfg.mode === 'video';

async function getStream(isVideo, withAudio) {
  const [w, h] = isVideo
    ? ({ 2160: [3840, 2160], 1080: [1920, 1080], 720: [1280, 720] }[cfg.videoRes] || [1920, 1080])
    : ({ max: [4032, 3024], '4k': [3840, 2160], fhd: [1920, 1080] }[cfg.photoRes] || [4032, 3024]);
  const fps = isVideo ? Number(cfg.fps) : 30;
  const facing = { ideal: cfg.facing };
  const attempts = [
    { facingMode: facing, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: fps } },
    { facingMode: facing, width: { ideal: w }, height: { ideal: h } },
    { facingMode: facing }
  ];
  const audio = withAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false;
  let err;
  for (const v of attempts) {
    try { return await navigator.mediaDevices.getUserMedia({ video: v, audio }); }
    catch (e) { err = e; if (e.name === 'NotAllowedError' || e.name === 'SecurityError') break; }
  }
  throw err;
}

function startCamera() {
  // 同時起動を直列化
  startingCamera = (startingCamera || Promise.resolve()).then(_startCamera, _startCamera);
  return startingCamera;
}
async function _startCamera() {
  if (recording) return;
  stopStream();
  viewport.classList.add('switching');
  $('#camerror').hidden = true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return showError('このブラウザはカメラAPIに対応していません。HTTPS(GitHub Pages)で、Safariから開いてください。');
  }
  const v = isVideoMode();
  try {
    try { stream = await getStream(v, v && cfg.audio); }
    catch (e) {
      if (v && cfg.audio && e.name === 'NotAllowedError') { toast('マイクが許可されないため、音声なしで録画します'); cfg.audio = false; saveCfg(); stream = await getStream(v, false); }
      else throw e;
    }
  } catch (e) {
    const m = {
      NotAllowedError: 'カメラの使用が許可されていません。設定 > Safari(またはこのアプリ) > カメラ から許可してください。',
      NotFoundError: 'カメラが見つかりません。',
      NotReadableError: 'カメラが他のアプリで使用中です。'
    }[e.name] || ('カメラの起動に失敗しました: ' + (e.message || e.name));
    return showError(m);
  }
  video.srcObject = stream;
  video.classList.toggle('mirror', cfg.facing === 'user');
  try { await video.play(); } catch (_) {}
  track = stream.getVideoTracks()[0];
  track.addEventListener('ended', () => { if (!recording) setTimeout(startCamera, 400); });

  const caps = track.getCapabilities ? track.getCapabilities() : {};
  hwZoom = !!(caps.zoom && caps.zoom.max > caps.zoom.min);
  if (hwZoom) { zmin = caps.zoom.min; zmax = Math.min(caps.zoom.max, 10); }
  else { zmin = 1; zmax = 10; }
  if (caps.focusMode && caps.focusMode.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  zoom = clamp(zoom, zmin, zmax);
  buildZoomUI();
  setZoom(zoom, true);
  layout();
  updateResChip();
  lockScreen();
  aeLocked = false; updateLockUI(); setupExposure(caps);
  viewport.classList.remove('switching');
}
function stopStream() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null; track = null; video.srcObject = null;
}
function showError(msg) { viewport.classList.remove('switching'); $('#camerror-msg').textContent = msg; $('#camerror').hidden = false; }

function updateResChip() {
  const s = track ? track.getSettings() : {};
  const w = video.videoWidth || s.width, h = video.videoHeight || s.height;
  const fmt = isVideoMode() ? `${Math.round(s.frameRate || cfg.fps)}fps` : (cfg.fmt === 'png' ? 'PNG' : 'JPEG ' + Math.round(cfg.quality * 100));
  $('#chip-res').textContent = w ? `${w}×${h} · ${fmt}` : '—';
}

/* ---------- 画面スリープ防止 ---------- */
let wake = null;
async function lockScreen() { try { if (navigator.wakeLock && document.visibilityState === 'visible') wake = await navigator.wakeLock.request('screen'); } catch (_) {} }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    lockScreen();
    if (!recording && (!track || track.readyState !== 'live')) startCamera();
  }
});

/* ---------- レイアウト(プレビュー枠のアスペクト) ---------- */
function layout() {
  const vw = video.videoWidth || 4, vh = video.videoHeight || 3;
  const ar = cfg.mode === 'square' ? 1 : vw / vh;
  const cw = stage.clientWidth - 20, ch = stage.clientHeight - 20;
  let w = cw, h = cw / ar;
  if (h > ch) { h = ch; w = ch * ar; }
  viewport.style.width = Math.floor(w) + 'px'; viewport.style.height = Math.floor(h) + 'px';
  applyTransform();
}
window.addEventListener('resize', layout);
window.addEventListener('orientationchange', () => setTimeout(layout, 300));
video.addEventListener('loadedmetadata', () => { layout(); updateResChip(); });
video.addEventListener('resize', () => { layout(); updateResChip(); });
if (window.ResizeObserver) new ResizeObserver(layout).observe(stage);

/* ---------- ズーム(ハードウェア対応ならそれを、無ければデジタル) ---------- */
const digital = () => hwZoom ? 1 : zoom;
function applyTransform() {
  const d = digital();
  fx = clamp(fx, 1 / (2 * d), 1 - 1 / (2 * d)); fy = clamp(fy, 1 / (2 * d), 1 - 1 / (2 * d));
  if (d <= 1.0001) { fx = fy = .5; }
  zoomer.style.transform = d > 1.0001 ? `scale(${d}) translate(${-(fx - .5) * 100}%,${-(fy - .5) * 100}%)` : 'none';
}
let hwZoomBusy = false, hwZoomNext = null;
async function pushHwZoom(z) {
  if (hwZoomBusy) { hwZoomNext = z; return; }
  hwZoomBusy = true;
  try { await track.applyConstraints({ advanced: [{ zoom: z }] }); } catch (_) {}
  hwZoomBusy = false;
  if (hwZoomNext != null) { const n = hwZoomNext; hwZoomNext = null; pushHwZoom(n); }
}
function setZoom(z, force) {
  z = clamp(z, zmin, zmax);
  zoom = Math.round(z * 100) / 100;
  if (hwZoom && track) pushHwZoom(zoom);
  applyTransform();
  const label = (zoom % 1 === 0 ? zoom.toFixed(0) : zoom.toFixed(1)) + '×';
  $('#zoombtn').textContent = label;
  $('#zoomslider').value = zoom;
  $$('#zoompresets button').forEach(b => b.classList.toggle('sel', Math.abs(Number(b.dataset.z) - zoom) < 0.06));
}
function buildZoomUI() {
  const sl = $('#zoomslider'); sl.min = zmin; sl.max = zmax;
  const box = $('#zoompresets'); box.innerHTML = '';
  [0.5, 1, 2, 3, 5, 10].filter(z => z >= zmin - 1e-6 && z <= zmax + 1e-6).forEach(z => {
    const b = document.createElement('button'); b.textContent = z + '×'; b.dataset.z = z;
    b.onclick = () => { setZoom(z); keepZoomPanel(); }; box.appendChild(b);
  });
}
let zpTimer;
const panelShow = on => $('#zoompanel').classList.toggle('show', on);
function keepZoomPanel() { clearTimeout(zpTimer); zpTimer = setTimeout(() => panelShow(false), 4500); }
$('#zoombtn').onclick = () => { const on = !$('#zoompanel').classList.contains('show'); panelShow(on); if (on) keepZoomPanel(); };

/* ---------- 露出補正 / AE・AFロック ---------- */
let aeLocked = false;
function setupExposure(caps) {
  const ec = caps.exposureCompensation, row = $('#exprow');
  if (ec && ec.max > ec.min) { const sl = $('#expslider'); sl.min = ec.min; sl.max = ec.max; sl.step = ec.step || 0.1; sl.value = 0; row.hidden = false; }
  else row.hidden = true;
}
$('#expslider').oninput = e => { if (track) track.applyConstraints({ advanced: [{ exposureCompensation: parseFloat(e.target.value) }] }).catch(() => {}); keepZoomPanel(); };
function updateLockUI() { $('#chip-lock').hidden = !aeLocked; if (!aeLocked) $('#focus').classList.remove('lock'); }
async function setAeLock(on) {
  if (!track) return false;
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  const fm = caps.focusMode || [], em = caps.exposureMode || [], adv = {};
  if (on) { if (fm.includes('manual')) adv.focusMode = 'manual'; if (em.includes('manual')) adv.exposureMode = 'manual'; }
  else { if (fm.includes('continuous')) adv.focusMode = 'continuous'; if (em.includes('continuous')) adv.exposureMode = 'continuous'; }
  if (!Object.keys(adv).length) { toast('このカメラはAE/AFロックに対応していません'); return false; }
  try { await track.applyConstraints({ advanced: [adv] }); } catch (e) { toast('AE/AFロックに失敗しました'); return false; }
  aeLocked = on; updateLockUI(); toast(on ? 'AE/AFロック中(もう一度長押しで解除)' : 'AE/AFロックを解除しました');
  return true;
}
$('#zoomslider').oninput = e => { setZoom(parseFloat(e.target.value)); keepZoomPanel(); };

/* ---------- ジェスチャ(ピンチ=ズーム / ドラッグ=パン / タップ=ピント) ---------- */
(() => {
  const ptrs = new Map(); let pinch = null, pan = null, lpT = null;
  const dist = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  viewport.addEventListener('pointerdown', e => {
    viewport.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) { pinch = { d: dist(), z: zoom }; pan = null; clearTimeout(lpT); }
    else {
      pan = { x: e.clientX, y: e.clientY, fx, fy, moved: false, t: performance.now() };
      const cx = e.clientX, cy = e.clientY; clearTimeout(lpT);
      lpT = setTimeout(async () => {
        if (!pan || pan.moved) return; pan.long = true;
        const ok = await setAeLock(!aeLocked);
        if (ok && aeLocked) { const r = viewport.getBoundingClientRect(), f = $('#focus'); f.hidden = true; void f.offsetWidth; f.className = 'lock'; f.style.left = (cx - r.left) + 'px'; f.style.top = (cy - r.top) + 'px'; f.hidden = false; }
        else if (ok) $('#focus').hidden = true;
      }, 550);
    }
  });
  viewport.addEventListener('pointermove', e => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2 && pinch) { setZoom(pinch.z * dist() / pinch.d); keepZoomPanel(); }
    else if (pan && ptrs.size === 1) {
      const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
      if (Math.hypot(dx, dy) > 8) { pan.moved = true; clearTimeout(lpT); }
      if (pan.moved && digital() > 1.0001) {
        const mir = cfg.facing === 'user' ? -1 : 1;
        fx = pan.fx - (dx / viewport.clientWidth) / digital(); fy = pan.fy - (dy / viewport.clientHeight) / digital();
        applyTransform();
      }
    }
  });
  const end = e => {
    clearTimeout(lpT);
    if (pan && !pan.moved && !pan.long && ptrs.size === 1 && performance.now() - pan.t < 400) tapFocus(e);
    ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (ptrs.size === 0) pan = null;
  };
  viewport.addEventListener('pointerup', end); viewport.addEventListener('pointercancel', e => { ptrs.delete(e.pointerId); pinch = pan = null; });
  viewport.addEventListener('wheel', e => { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); }, { passive: false });
})();

function tapFocus(e) {
  panelShow(false); if (aeLocked) return;
  const r = viewport.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const f = $('#focus'); f.hidden = true; void f.offsetWidth; f.className = ''; f.style.left = x + 'px'; f.style.top = y + 'px'; f.hidden = false;
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    const adv = {};
    if (caps.pointsOfInterest) adv.pointsOfInterest = [{ x: clamp(x / r.width, 0, 1), y: clamp(y / r.height, 0, 1) }];
    if (caps.focusMode && caps.focusMode.includes('single-shot')) adv.focusMode = 'single-shot';
    if (Object.keys(adv).length) track.applyConstraints({ advanced: [adv] }).catch(() => {});
  } catch (_) {}
}

/* =====================================================================
   撮影(無音:canvas で原寸フレームを書き出し)
   ===================================================================== */
// プレビュー表示範囲 → ソース映像上の切り出し矩形(整数ピクセル)
function cropParams() {
  const vw = video.videoWidth, vh = video.videoHeight;
  let bx = 0, by = 0, bw = vw, bh = vh;
  if (cfg.mode === 'square') { const s = Math.min(vw, vh); bw = bh = s; bx = Math.round((vw - s) / 2); by = Math.round((vh - s) / 2); }
  const d = digital();
  const mir = cfg.facing === 'user';
  const fxs = mir ? 1 - fx : fx;
  const cw = Math.round(bw / d), ch = Math.round(bh / d);
  const sx = clamp(Math.round(bx + fxs * bw - cw / 2), 0, vw - cw);
  const sy = clamp(Math.round(by + fy * bh - ch / 2), 0, vh - ch);
  const fit = cfg.zoomOut === 'fit' && d > 1.0001;
  return { sx, sy, sw: cw, sh: ch, ow: fit ? bw : cw, oh: fit ? bh : ch, mirror: mir && cfg.mirror };
}
async function snapshot() {
  const p = cropParams(); let bmp;
  try { bmp = await createImageBitmap(video); }
  catch (_) { const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight; c.getContext('2d').drawImage(video, 0, 0); bmp = c; }
  return { bmp, p, ts: Date.now() };
}
let encCanvas = null, thumbCanvas = null;
const toBlob = (c, type, q) => new Promise(r => c.toBlob(r, type, q));
async function makeThumb(bmp, p) {
  const c = thumbCanvas || (thumbCanvas = document.createElement('canvas'));
  const k = 360 / Math.max(p.sw, p.sh); c.width = Math.max(1, Math.round(p.sw * k)); c.height = Math.max(1, Math.round(p.sh * k));
  const x = c.getContext('2d'); x.imageSmoothingQuality = 'medium';
  x.drawImage(bmp, p.sx, p.sy, p.sw, p.sh, 0, 0, c.width, c.height);
  return toBlob(c, 'image/jpeg', 0.78);
}
function fileBase(def) {
  let b = (cfg.prefix || '').trim().replace(/[\\/:*?"<>|]/g, '_'); if (!b || b === 'IMG') b = def;
  return /[_\-]$/.test(b) ? b : b + '_';
}
// 自動レベル補正(紙の白を白へ・黒を黒へ)/ 白黒資料化。元画像は変更せず別コピーとして保存
function enhanceCanvas(c, gray) {
  const x = c.getContext('2d'), img = x.getImageData(0, 0, c.width, c.height), d = img.data, n = d.length;
  const h = new Uint32Array(256), total = c.width * c.height;
  for (let i = 0; i < n; i += 4) h[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++;
  let lo = 0, hi = 255, acc = 0;
  for (let i = 0; i < 256; i++) { acc += h[i]; if (acc > total * .005) { lo = i; break; } }
  acc = 0; for (let i = 255; i >= 0; i--) { acc += h[i]; if (acc > total * .01) { hi = i; break; } }
  if (hi - lo < 32) { lo = 0; hi = 255; }
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.pow(clamp((i - lo) / (hi - lo), 0, 1), gray ? 1.1 : .95) * 255;
  for (let i = 0; i < n; i += 4) {
    if (gray) { const v = lut[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]; d[i] = d[i + 1] = d[i + 2] = v; }
    else { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
  }
  x.putImageData(img, 0, 0);
}
async function saveEnhanced(c, ts, ext) {
  enhanceCanvas(c, cfg.enhMode === 'gray');
  const blob = await toBlob(c, 'image/jpeg', Math.max(cfg.quality, .95)); if (!blob) return;
  const thumb = await makeThumb(c, { sx: 0, sy: 0, sw: c.width, sh: c.height });
  const meta = { type: 'photo', ts: ts + 1, fav: false, name: `${fileBase('IMG')}${stamp(ts)}_enh.jpg`, w: c.width, h: c.height, size: blob.size, mime: 'image/jpeg', thumb };
  return DB.add(meta, blob);
}
async function encodeAndSave(s) {
  const { bmp, p, ts } = s;
  const c = encCanvas || (encCanvas = document.createElement('canvas'));
  c.width = p.ow; c.height = p.oh;
  const x = c.getContext('2d', { alpha: false });
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  if (p.mirror) x.setTransform(-1, 0, 0, 1, p.ow, 0); else x.setTransform(1, 0, 0, 1, 0, 0);
  x.drawImage(bmp, p.sx, p.sy, p.sw, p.sh, 0, 0, p.ow, p.oh);
  const png = cfg.fmt === 'png';
  const type = png ? 'image/png' : 'image/jpeg';
  const blob = await toBlob(c, type, cfg.quality);
  if (!blob) throw new Error('画像の書き出しに失敗しました');
  const thumb = await makeThumb(bmp, p);
  const meta = { type: 'photo', ts, fav: false, name: `${fileBase('IMG')}${stamp(ts)}.${png ? 'png' : 'jpg'}`, w: p.ow, h: p.oh, size: blob.size, mime: type, thumb };
  const saved = await DB.add(meta, blob);
  if (cfg.enhance) { try { await saveEnhanced(c, ts); } catch (e) { toast('補正コピーの保存に失敗しました'); } }
  return saved;
}
// 保存キュー(1本ずつ処理しメモリ消費を抑える)
const encQ = []; let encBusy = false, pending = 0;
function updatePending() { $('#pending-chip').hidden = pending === 0; $('#pending-n').textContent = pending; }
function enqueue(s) { encQ.push(s); pending++; updatePending(); pump(); }
async function pump() {
  if (encBusy) return; encBusy = true;
  while (encQ.length) {
    const s = encQ.shift();
    try { setThumb(await encodeAndSave(s)); }
    catch (e) { toast('保存に失敗しました: ' + (e && (e.name === 'QuotaExceededError' ? '容量不足' : e.message) || e)); }
    if (s.bmp.close) s.bmp.close();
    pending--; updatePending();
  }
  encBusy = false;
}
function setThumb(meta) {
  const img = $('#thumb'); if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  const u = URL.createObjectURL(meta.thumb); img.dataset.url = u; img.src = u; const g = $('#btn-gallery'); g.classList.add('has');
  if (!reduceMotion()) { g.classList.remove('pop'); void g.offsetWidth; g.classList.add('pop'); }
}
function flashFx() {
  const sh = $('#shutter'); sh.classList.remove('pop'); void sh.offsetWidth; sh.classList.add('pop');
  if (cfg.flash) { const f = $('#flashfx'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }
  flyToThumb();
}
let lastFly = 0;
function flyToThumb() {
  const now = performance.now(); if (reduceMotion() || now - lastFly < 380 || !video.videoWidth) return; lastFly = now;
  const vr = viewport.getBoundingClientRect(), tr = $('#btn-gallery').getBoundingClientRect();
  const c = document.createElement('canvas'); c.width = 260; c.height = Math.max(1, Math.round(260 * vr.height / vr.width)); c.className = 'fly';
  try { c.getContext('2d').drawImage(video, 0, 0, c.width, c.height); } catch (_) {}
  c.style.cssText = `left:${vr.left}px;top:${vr.top}px;width:${vr.width}px;height:${vr.height}px;border-radius:22px`;
  document.body.appendChild(c);
  const dx = tr.left + tr.width / 2 - (vr.left + vr.width / 2), dy = tr.top + tr.height / 2 - (vr.top + vr.height / 2), k = tr.width / vr.width;
  const a = c.animate([{ transform: 'none', opacity: 1 }, { transform: `translate(${dx * .6}px,${dy * .6 - 30}px) scale(${Math.max(k * 2.2, .35)})`, opacity: .9, offset: .55 }, { transform: `translate(${dx}px,${dy}px) scale(${k})`, opacity: .15, borderRadius: '40px' }], { duration: 520, easing: 'cubic-bezier(.4,0,.2,1)' });
  a.onfinish = a.oncancel = () => c.remove();
}

async function shootOnce() {
  if (!stream || !video.videoWidth) return;
  try { if (cfg.steady) await waitSteady(); const s = await snapshot(); flashFx(); enqueue(s); }
  catch (e) { toast('撮影に失敗しました'); }
}
async function shootWithTimer() {
  if (countdownTimer) { cancelCountdown(); return; }
  if (!cfg.timer) return shootOnce();
  let n = cfg.timer; const cd = $('#countdown'); cd.hidden = false; cd.innerHTML = `<span>${n}</span>`;
  countdownTimer = setInterval(() => {
    n--; if (n <= 0) { cancelCountdown(); shootOnce(); } else cd.innerHTML = `<span>${n}</span>`;
  }, 1000);
}
function cancelCountdown() { clearInterval(countdownTimer); countdownTimer = null; $('#countdown').hidden = true; }

async function burstLoop() {
  if (burstRunning || !stream) return;
  burstRunning = true; app.classList.add('bursting');
  const chip = $('#burst-chip'); chip.hidden = false; let n = 0; $('#burst-n').textContent = 0;
  while (burstRunning && n < cfg.burstMax && stream) {
    while (encQ.length >= 3 && burstRunning) await sleep(15);
    if (!burstRunning) break;
    try { enqueue(await snapshot()); n++; $('#burst-n').textContent = n; chip.classList.remove('bump'); void chip.offsetWidth; chip.classList.add('bump'); flashFx(); } catch (_) {}
    await sleep(Math.max(Number(cfg.burstInterval), 0) || 0);
  }
  burstRunning = false; app.classList.remove('bursting');
  setTimeout(() => { if (!burstRunning) chip.hidden = true; }, 1200);
}

function triggerShutter() {
  if (isVideoMode()) return toggleRecord();
  if (cfg.burstMode) return burstRunning ? (burstRunning = false) : burstLoop();
  return shootWithTimer();
}
/* ---------- シャッターボタン ---------- */
(() => {
  const sh = $('#shutter'); let holdT = null, held = false, down = false;
  sh.addEventListener('pointerdown', e => {
    e.preventDefault(); down = true; held = false;
    if (isVideoMode() || cfg.burstMode) return;
    holdT = setTimeout(() => { held = true; burstLoop(); }, 380);   // 長押し=連写
  });
  const up = () => {
    if (!down) return; down = false; clearTimeout(holdT);
    if (held) { burstRunning = false; return; }
    triggerShutter();
  };
  sh.addEventListener('pointerup', up);
  sh.addEventListener('pointercancel', () => { down = false; clearTimeout(holdT); if (held) burstRunning = false; });
  sh.addEventListener('contextmenu', e => e.preventDefault());
})();
$('#btn-snap').onclick = shootOnce;

/* ---------- ビデオ録画 ---------- */
let rec = null, recChunks = [], recStart = 0, recTimer = null, recThumb = null;
function pickMime() {
  if (!window.MediaRecorder) return null;
  const c = ['video/mp4;codecs=avc1.640033', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return c.find(t => MediaRecorder.isTypeSupported(t)) || '';
}
async function toggleRecord() { recording ? stopRecord() : startRecord(); }
async function startRecord() {
  if (!stream) return;
  const mime = pickMime();
  if (mime === null) return toast('このブラウザは録画に対応していません');
  const bps = { 2160: 45e6, 1080: 18e6, 720: 9e6 }[cfg.videoRes] * (Number(cfg.fps) > 30 ? 1.5 : 1);
  try { rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: bps }); }
  catch (e) { try { rec = new MediaRecorder(stream); } catch (e2) { return toast('録画を開始できません'); } }
  recChunks = [];
  try { recThumb = await snapshot(); } catch (_) { recThumb = null; }
  rec.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
  rec.onstop = finalizeRecord;
  rec.start(1000);
  recording = true; recStart = Date.now();
  app.classList.add('recording'); $('#btn-snap').hidden = false; $('#rec-chip').hidden = false;
  $('#rec-time').textContent = '0:00';
  recTimer = setInterval(() => $('#rec-time').textContent = fmtDur((Date.now() - recStart) / 1000), 500);
}
function stopRecord() { if (rec && rec.state !== 'inactive') rec.stop(); }
async function finalizeRecord() {
  clearInterval(recTimer);
  const dur = (Date.now() - recStart) / 1000;
  recording = false; app.classList.remove('recording'); $('#btn-snap').hidden = true; $('#rec-chip').hidden = true;
  const type = (rec.mimeType || 'video/mp4').split(';')[0];
  const blob = new Blob(recChunks, { type }); recChunks = [];
  const ext = type.includes('webm') ? 'webm' : 'mp4';
  try {
    const s = track ? track.getSettings() : {};
    let thumb = null;
    if (recThumb) { thumb = await makeThumb(recThumb.bmp, recThumb.p); if (recThumb.bmp.close) recThumb.bmp.close(); }
    const ts = recStart;
    const meta = { type: 'video', ts, fav: false, name: `${fileBase('VID')}${stamp(ts)}.${ext}`, w: s.width || video.videoWidth, h: s.height || video.videoHeight, size: blob.size, mime: type, dur, thumb: thumb || new Blob([], { type: 'image/jpeg' }) };
    setThumb(await DB.add(meta, blob));
    toast(`ビデオを保存しました(${fmtDur(dur)} / ${fmtBytes(blob.size)})`);
  } catch (e) { toast('ビデオの保存に失敗: ' + (e.name === 'QuotaExceededError' ? '容量不足' : e.message)); }
  recThumb = null;
}

/* ---------- 各ボタン ---------- */
function syncUI() {
  app.dataset.mode = cfg.mode;
  $$('#modes .mode').forEach(b => b.classList.toggle('sel', b.dataset.mode === cfg.mode));
  $('#btn-burst').classList.toggle('on', cfg.burstMode);
  $('#btn-burst').hidden = isVideoMode();
  const tm = $('#btn-timer'); tm.classList.toggle('on', cfg.timer > 0); tm.hidden = isVideoMode();
  tm.querySelector('.ms').className = 'ms ' + (cfg.timer ? 'i-timer' : 'i-timer-off');
  $('#timer-sub').textContent = cfg.timer ? cfg.timer : '';
  $('#btn-grid').classList.toggle('on', cfg.grid); $('#gridlines').hidden = !cfg.grid;
  $('#btn-level').classList.toggle('on', cfg.level); $('#level').hidden = !cfg.level;
  $('#btn-enh').classList.toggle('on', cfg.enhance);
  $('#btn-dim').classList.toggle('on', cfg.dim > 0); $('#dim').style.opacity = cfg.dim;
  document.documentElement.classList.toggle('noanim', !cfg.anim);
  moveInd();
  updateResChip();
}
function moveInd() {
  const sel = $('#modes .mode.sel'), ind = $('#modes .ind'); if (!sel) return;
  ind.style.width = sel.offsetWidth + 'px'; ind.style.height = sel.offsetHeight + 'px';
  ind.style.transform = `translate(${sel.offsetLeft}px,${sel.offsetTop}px)`;
}
window.addEventListener('resize', () => setTimeout(moveInd, 50));
window.addEventListener('orientationchange', () => setTimeout(moveInd, 350));
if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveInd);
$$('#modes .mode').forEach(b => b.onclick = async () => {
  if (recording || burstRunning) return;
  const prevVideo = isVideoMode(); cfg.mode = b.dataset.mode; saveCfg(); syncUI(); layout();
  if (prevVideo !== isVideoMode()) await startCamera();
});
$('#btn-burst').onclick = () => { cfg.burstMode = !cfg.burstMode; saveCfg(); syncUI(); toast(cfg.burstMode ? '連写モード: シャッターで開始/停止' : '連写モードOFF(シャッター長押しで連写)'); };
$('#btn-timer').onclick = () => { cfg.timer = { 0: 3, 3: 10, 10: 0 }[cfg.timer] || 0; saveCfg(); syncUI(); };
let flipRot = 0;
$('#btn-flip').onclick = async () => { if (recording) return; flipRot += 180; $('#btn-flip .ms').style.transform = `rotate(${flipRot}deg)`; cfg.facing = cfg.facing === 'user' ? 'environment' : 'user'; zoom = 1; fx = fy = .5; saveCfg(); await startCamera(); };
$('#btn-grid').onclick = () => { cfg.grid = !cfg.grid; saveCfg(); syncUI(); };
$('#btn-level').onclick = () => toggleLevel(!cfg.level);
$('#btn-enh').onclick = () => { cfg.enhance = !cfg.enhance; saveCfg(); syncUI(); syncSettings(); toast(cfg.enhance ? '資料補正コピーを同時保存します(元画像はそのまま)' : '資料補正コピーをOFFにしました'); };
$('#btn-dim').onclick = () => { cfg.dim = { 0: .35, .35: .6, .6: 0 }[cfg.dim] || 0; saveCfg(); syncUI(); syncSettings(); };
$('#btn-retry').onclick = startCamera;

/* =====================================================================
   水準器(加速度センサー)  真上撮影=十字 / 立てた状態=水平線
   ===================================================================== */
const LV = { x: 0, y: 0, z: 9.8, jit: 9, on: false, raf: 0, perm: false };
async function ensureMotion() {
  if (LV.perm) return true;
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) {
      if (await DeviceMotionEvent.requestPermission() !== 'granted') { toast('モーションセンサーの許可が必要です'); return false; }
    }
  } catch (e) { toast('モーションセンサーを有効にできません'); return false; }
  LV.perm = true; return true;
}
function syncMotion() {
  const need = cfg.level || cfg.steady;
  if (need && !LV.on) { window.addEventListener('devicemotion', onMotion); LV.on = true; }
  if (!need && LV.on) { window.removeEventListener('devicemotion', onMotion); LV.on = false; }
  cancelAnimationFrame(LV.raf); if (cfg.level) renderLevel();
}
async function toggleLevel(on) {
  if (on && !(await ensureMotion())) on = false;
  cfg.level = on; saveCfg(); syncUI(); syncSettings(); syncMotion();
}
async function toggleSteady(on) {
  if (on && !(await ensureMotion())) on = false;
  cfg.steady = on; saveCfg(); syncSettings(); syncMotion();
}
function onMotion(e) {
  const a = e.accelerationIncludingGravity; if (!a || a.x == null) return;
  const k = IOS ? -1 : 1, f = .25;     // iOSは符号が仕様と逆 / ローパスで安定化
  const nx = a.x * k, ny = a.y * k, nz = a.z * k;
  LV.jit += (Math.hypot(nx - LV.x, ny - LV.y, nz - LV.z) - LV.jit) * .3;   // 揺れ量(小さいほど静止)
  LV.x += (nx - LV.x) * f; LV.y += (ny - LV.y) * f; LV.z += (nz - LV.z) * f;
}
// 端末の揺れが収まるまで待つ(最大1.5秒)
async function waitSteady() {
  if (!LV.on) return;
  const t0 = performance.now(); let calm = 0;
  while (performance.now() - t0 < 1500) {
    calm = LV.jit < .12 ? calm + 1 : 0;
    if (calm >= 4) return;
    await sleep(30);
  }
}
function renderLevel() {
  const g = Math.hypot(LV.x, LV.y, LV.z) || 1;
  const ux = LV.x / g, uy = LV.y / g, uz = LV.z / g;
  const ang = (screen.orientation ? screen.orientation.angle : (window.orientation || 0)) * Math.PI / 180;
  const sx = ux * Math.cos(ang) - uy * Math.sin(ang), sy = ux * Math.sin(ang) + uy * Math.cos(ang);
  const flat = Math.abs(uz) > 0.8;
  $('#lv-flat').hidden = !flat; $('#lv-line').hidden = flat;
  let ok;
  if (flat) {
    $('#lv-dot').style.transform = `translate(${sx * 700}px,${-sy * 700}px)`;
    ok = Math.hypot(sx, sy) < 0.02;
  } else {
    let phi = Math.atan2(sx, sy) * 180 / Math.PI; if (phi > 90) phi -= 180; if (phi < -90) phi += 180;
    $('#lv-line').style.transform = `rotate(${phi}deg)`; ok = Math.abs(phi) < 1;
  }
  $('#level').classList.toggle('ok', ok);
  if (cfg.level) LV.raf = requestAnimationFrame(renderLevel);
}

/* =====================================================================
   ギャラリー
   ===================================================================== */
const gallery = $('#gallery'), viewer = $('#viewer');
let gItems = [], gFilter = 'all', gSel = new Set(), gSelecting = false, gUrls = [];
const visibleItems = () => gItems.filter(i => gFilter === 'all' ? true : gFilter === 'fav' ? !!i.fav : i.type === gFilter);

async function openGallery() { show(gallery); await refreshGallery(); }
async function refreshGallery() {
  gItems = (await DB.list()).sort((a, b) => b.ts - a.ts);
  renderGallery();
}
function renderGallery() {
  gUrls.forEach(u => URL.revokeObjectURL(u)); gUrls = [];
  const grid = $('#g-grid'); grid.innerHTML = ''; grid.classList.toggle('selecting', gSelecting);
  const list = visibleItems();
  $('#g-empty').hidden = list.length > 0;
  const frag = document.createDocumentFragment();
  list.forEach((it, idx) => {
    const c = document.createElement('button'); c.className = 'cell' + (gSel.has(it.id) ? ' sel' : ''); c.style.setProperty('--i', Math.min(idx, 24));
    const img = new Image(); if (it.thumb && it.thumb.size) { const u = URL.createObjectURL(it.thumb); gUrls.push(u); img.src = u; } img.alt = ''; c.appendChild(img);
    if (it.type === 'video') { const d = document.createElement('span'); d.className = 'dur'; d.innerHTML = '<span class="ms i-play-arrow"></span>' + fmtDur(it.dur || 0); c.appendChild(d); }
    if (it.fav) { const f = document.createElement('span'); f.className = 'ms i-star fv'; c.appendChild(f); }
    const ck = document.createElement('span'); ck.className = 'ck'; ck.innerHTML = '<span class="ms i-check"></span>'; c.appendChild(ck);
    c.onclick = () => gSelecting ? toggleSel(it.id, c) : openViewer(idx);
    frag.appendChild(c);
  });
  grid.appendChild(frag);
  updateSelBar();
}
function toggleSel(id, cell) { gSel.has(id) ? gSel.delete(id) : gSel.add(id); cell.classList.toggle('sel', gSel.has(id)); updateSelBar(); }
function updateSelBar() {
  $('#g-actions').hidden = !gSelecting; $('#g-count').textContent = `${gSel.size}件選択`;
  $('#g-select-t').textContent = gSelecting ? '完了' : '選択';
  $('#g-total').textContent = `${visibleItems().length}件`;
  $('#g-title').textContent = gSelecting ? '項目を選択' : 'ギャラリー';
  ['#g-share', '#g-del', '#g-fav', '#g-zip'].forEach(s => $(s).disabled = gSel.size === 0);
}
$('#btn-gallery').onclick = openGallery;
$('#g-close').onclick = () => { hide(gallery); gSelecting = false; gSel.clear(); gUrls.forEach(u => URL.revokeObjectURL(u)); gUrls = []; refreshLastThumb(); };
$('#g-select').onclick = () => { gSelecting = !gSelecting; if (!gSelecting) gSel.clear(); renderGallery(); };
$('#g-all').onclick = () => { visibleItems().forEach(i => gSel.add(i.id)); renderGallery(); };
$$('#g-filters .fchip').forEach(b => b.onclick = () => { gFilter = b.dataset.f; $$('#g-filters .fchip').forEach(x => x.classList.toggle('sel', x === b)); renderGallery(); });
$('#g-share').onclick = () => shareRecs(gItems.filter(i => gSel.has(i.id)));
$('#g-fav').onclick = async () => {
  const recs = gItems.filter(i => gSel.has(i.id)); if (!recs.length) return;
  const to = !recs.every(r => r.fav);
  for (const r of recs) { r.fav = to; await DB.put(r); }
  renderGallery(); toast(to ? `${recs.length}件をお気に入りに追加` : `${recs.length}件のお気に入りを解除`);
};
$('#g-zip').onclick = async () => {
  const recs = gItems.filter(i => gSel.has(i.id)); if (!recs.length) return;
  if (recs.reduce((a, r) => a + r.size, 0) > 800e6) return toast('合計が大きすぎます。800MB以下ずつに分けてください', 4000);
  try {
    toast('ZIPを作成中…', 120000);
    const blob = await buildZip(recs, (i, n) => toast(`ZIPを作成中… ${i}/${n}`, 120000));
    toast('ZIPを作成しました');
    await shareFiles([new File([blob], `silentcam_${stamp(Date.now()).slice(0, 15)}.zip`, { type: 'application/zip' })]);
  } catch (e) { toast('ZIP作成に失敗しました: ' + (e.message || e), 4000); }
};

/* ---------- ZIP作成(無圧縮・ストア形式。JPEG/動画はもともと圧縮済みのため画質への影響なし) ---------- */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
async function buildZip(recs, onProgress) {
  const enc = new TextEncoder(), parts = [], central = []; let offset = 0, csize = 0;
  const d = new Date(), dt = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dd = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i], u8 = new Uint8Array(await (await DB.blob(r.id)).arrayBuffer()), name = enc.encode(r.name), crc = crc32(u8);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(10, dt, true); lh.setUint16(12, dd, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, u8.length, true); lh.setUint32(22, u8.length, true); lh.setUint16(26, name.length, true);
    parts.push(lh.buffer, name, u8);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(12, dt, true); ch.setUint16(14, dd, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, u8.length, true); ch.setUint32(24, u8.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(ch.buffer, name); csize += 46 + name.length;
    offset += 30 + name.length + u8.length;
    if (onProgress) onProgress(i + 1, recs.length);
    await sleep(0);
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, recs.length, true); end.setUint16(10, recs.length, true); end.setUint32(12, csize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
$('#g-del').onclick = async () => {
  const ids = [...gSel]; if (!ids.length) return;
  if (await dialog({ title: `${ids.length}件を削除`, text: 'この端末内の撮影データから完全に削除します。写真Appなどに書き出したコピーは消えません。', ok: '削除' })) {
    await DB.del(ids); gSel.clear(); await refreshGallery(); toast('削除しました');
  }
};
async function refreshLastThumb() {
  try {
    const l = (await DB.list()).sort((a, b) => b.ts - a.ts)[0];
    const img = $('#thumb'); if (img.dataset.url) { URL.revokeObjectURL(img.dataset.url); img.dataset.url = ''; }
    if (l && l.thumb && l.thumb.size) setThumb(l); else { img.removeAttribute('src'); $('#btn-gallery').classList.remove('has'); }
  } catch (_) {}
}

/* ---------- 共有 / ダウンロード ---------- */
async function recToFile(r) { return new File([await DB.blob(r.id)], r.name, { type: r.mime }); }
async function shareRecs(recs) {
  if (!recs.length) return;
  return shareFiles(await Promise.all(recs.map(recToFile)));
}
async function shareFiles(files) {
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); return; }
    catch (e) {
      if (e.name === 'AbortError') return;
      if (e.name === 'NotAllowedError') {   // ユーザー操作の有効期限切れ → もう一度タップしてもらう
        await dialog({ title: '共有の準備ができました', text: `${files.length}件のファイルを書き出します。「共有を開く」から「画像を保存」または「“ファイル”に保存」を選んでください。`, ok: '共有を開く', cancel: 'キャンセル', onOk: () => navigator.share({ files }).catch(() => {}) });
        return;
      }
    }
  }
  downloadFiles(files);
}
async function downloadFiles(files) {
  for (const f of files) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000); await sleep(500);
  }
}

/* ---------- ビューア(ピンチ拡大 / スワイプ / ダブルタップ) ---------- */
let vList = [], vIdx = 0, vUrl = null; const V = { s: 1, x: 0, y: 0 };
async function openViewer(idx) {
  vList = visibleItems(); vIdx = clamp(idx, 0, vList.length - 1);
  show(viewer); await loadViewer();
}
async function loadViewer(dir = 0) {
  const it = vList[vIdx]; if (!it) { closeViewer(); return; }
  $('#v-title').textContent = it.name; $('#v-infobox').classList.remove('show'); $('#v-fav').classList.toggle('on', !!it.fav);
  $('#v-prev').hidden = vIdx === 0; $('#v-next').hidden = vIdx >= vList.length - 1;
  if (vUrl) URL.revokeObjectURL(vUrl);
  const blob = await DB.blob(it.id); vUrl = URL.createObjectURL(blob);
  const st = $('#vstage'); st.innerHTML = ''; V.s = 1; V.x = V.y = 0; st.className = dir < 0 ? 'l' : dir > 0 ? 'r' : '';
  let el;
  if (it.type === 'video') { el = document.createElement('video'); el.controls = true; el.playsInline = true; el.src = vUrl; }
  else { el = new Image(); el.src = vUrl; el.draggable = false; }
  st.appendChild(el);
}
function closeViewer() { hide(viewer); $('#vstage').innerHTML = ''; if (vUrl) { URL.revokeObjectURL(vUrl); vUrl = null; } refreshGallery(); }
const vStep = d => { const n = vIdx + d; if (n >= 0 && n < vList.length) { vIdx = n; loadViewer(d); } };
$('#v-close').onclick = closeViewer; $('#v-prev').onclick = () => vStep(-1); $('#v-next').onclick = () => vStep(1);
$('#v-share').onclick = () => shareRecs([vList[vIdx]]);
$('#v-download').onclick = async () => downloadFiles([await recToFile(vList[vIdx])]);
$('#v-del').onclick = async () => {
  const it = vList[vIdx];
  if (await dialog({ title: '削除', text: `${it.name} をこの端末内から削除します。`, ok: '削除' })) {
    await DB.del([it.id]); vList.splice(vIdx, 1);
    if (!vList.length) closeViewer(); else { vIdx = Math.min(vIdx, vList.length - 1); loadViewer(); }
    toast('削除しました');
  }
};
$('#v-info').onclick = () => {
  const b = $('#v-infobox'), it = vList[vIdx];
  b.innerHTML = `${it.name}<br>${it.w} × ${it.h} px(${(it.w * it.h / 1e6).toFixed(1)} MP)・${fmtBytes(it.size)}<br>${new Date(it.ts).toLocaleString('ja-JP')}${it.type === 'video' ? '<br>長さ ' + fmtDur(it.dur || 0) : ''}`;
  b.classList.toggle('show');
};
$('#v-fav').onclick = async () => { const it = vList[vIdx]; it.fav = !it.fav; await DB.put(it); $('#v-fav').classList.toggle('on', it.fav); toast(it.fav ? 'お気に入りに追加しました' : 'お気に入りを解除しました', 1500); };
document.addEventListener('keydown', e => { if (viewer.classList.contains('open')) { if (e.key === 'ArrowLeft') vStep(-1); if (e.key === 'ArrowRight') vStep(1); if (e.key === 'Escape') closeViewer(); } });
(() => {
  const st = $('#vstage'), ptrs = new Map(); let pinch = null, drag = null, lastTap = 0;
  const img = () => st.querySelector('img');
  const apply = () => { const i = img(); if (i) i.style.transform = `translate(${V.x}px,${V.y}px) scale(${V.s})`; };
  const dist = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  st.addEventListener('pointerdown', e => {
    if (e.target.tagName === 'VIDEO') return;
    st.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) { pinch = { d: dist(), s: V.s }; drag = null; }
    else drag = { x: e.clientX, y: e.clientY, vx: V.x, vy: V.y, t: performance.now() };
  });
  st.addEventListener('pointermove', e => {
    if (!ptrs.has(e.pointerId)) return; ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2 && pinch) { V.s = clamp(pinch.s * dist() / pinch.d, 1, 12); apply(); }
    else if (drag && V.s > 1.01) { V.x = drag.vx + e.clientX - drag.x; V.y = drag.vy + e.clientY - drag.y; apply(); }
  });
  const up = e => {
    if (drag && ptrs.size === 1) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y, dt = performance.now() - drag.t;
      if (V.s <= 1.01 && Math.abs(dx) > 70 && Math.abs(dy) < 70 && dt < 600) vStep(dx < 0 ? 1 : -1);
      else if (Math.hypot(dx, dy) < 8 && dt < 300) {
        if (performance.now() - lastTap < 320) { V.s = V.s > 1.01 ? 1 : 3; V.x = V.y = 0; apply(); lastTap = 0; } else lastTap = performance.now();
      }
    }
    ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (!ptrs.size) drag = null;
    if (V.s <= 1.01) { V.s = 1; V.x = V.y = 0; apply(); }
  };
  st.addEventListener('pointerup', up); st.addEventListener('pointercancel', e => { ptrs.delete(e.pointerId); pinch = drag = null; });
})();

/* =====================================================================
   設定
   ===================================================================== */
const settings = $('#settings');
const needsRestart = new Set(['photoRes', 'videoRes', 'fps', 'audio']);
let restartTimer;
function syncSettings() {
  $$('#settings [data-key]').forEach(el => {
    const k = el.dataset.key;
    if (el.classList.contains('seg')) $$('button', el).forEach(b => b.classList.toggle('sel', b.dataset.v === String(cfg[k])));
    else if (el.type === 'checkbox') el.checked = !!cfg[k];
    else if (el.type === 'text') { if (document.activeElement !== el) el.value = cfg[k] === 'IMG' ? '' : cfg[k]; }
    else if (el.type === 'range') el.value = cfg[k];
  });
  $('#q-val').textContent = Math.round(cfg.quality * 100);
}
function applyKey(k, v) {
  cfg[k] = v; saveCfg(); syncSettings(); syncUI();
  if (k === 'level') return toggleLevel(v);
  if (k === 'steady') return toggleSteady(v);
  if (needsRestart.has(k)) { clearTimeout(restartTimer); restartTimer = setTimeout(startCamera, 350); }
}
$$('#settings .seg').forEach(seg => $$('button', seg).forEach(b => b.onclick = () => {
  const raw = b.dataset.v, v = /^-?\d+(\.\d+)?$/.test(raw) && !['videoRes'].includes(seg.dataset.key) ? Number(raw) : raw;
  applyKey(seg.dataset.key, v);
}));
$$('#settings input[type=checkbox]').forEach(el => el.onchange = () => applyKey(el.dataset.key, el.checked));
$$('#settings input[type=text]').forEach(el => el.oninput = () => applyKey(el.dataset.key, el.value.trim() || 'IMG'));
$$('#settings input[type=range]').forEach(el => el.oninput = () => applyKey(el.dataset.key, parseFloat(el.value)));
$('#btn-settings').onclick = async () => { syncSettings(); show(settings); updateUsage(); };
$('#s-close').onclick = () => hide(settings);
settings.addEventListener('click', e => { if (e.target === settings) hide(settings); });
async function updateUsage() {
  let t = '—';
  try { const e = await navigator.storage.estimate(); t = `${fmtBytes(e.usage || 0)} / 利用可能 約${fmtBytes(e.quota || 0)}`; } catch (_) {}
  $('#s-usage').textContent = t;
}
$('#s-wipe').onclick = async () => {
  if (await dialog({ title: 'すべて削除', text: 'アプリ内に保存したすべての写真・ビデオを削除します。元に戻せません。', ok: 'すべて削除' })) {
    await DB.clear(); await refreshLastThumb(); updateUsage(); toast('すべて削除しました');
  }
};

/* ---------- 外部キーボード / Bluetoothリモコン ---------- */
document.addEventListener('keydown', e => {
  const t = document.activeElement; if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type === 'text'))) return;
  if ([gallery, viewer, settings, $('#dlg')].some(x => x.classList.contains('open')) || e.repeat || e.metaKey || e.ctrlKey) return;
  if ([' ', 'Enter', 'ArrowRight', 'PageDown', 'MediaTrackNext', 'AudioVolumeUp'].includes(e.key)) { e.preventDefault(); triggerShutter(); }
  else if (['+', '=', 'ArrowUp'].includes(e.key)) { e.preventDefault(); setZoom(zoom + .5); }
  else if (['-', '_', 'ArrowDown'].includes(e.key)) { e.preventDefault(); setZoom(zoom - .5); }
  else if (e.key === 'g' || e.key === 'G') $('#btn-grid').click();
});

/* =====================================================================
   起動
   ===================================================================== */
(async function init() {
  syncSettings(); syncUI();
  if (document.fonts && document.fonts.load) document.fonts.load('24px "Material Symbols Outlined"', '\ue429').then(f => { if (!f.length) toast('アイコンフォントを読み込めませんでした。ページを再読み込みしてください', 5000); }).catch(() => {});
  try { await DB.open(); await refreshLastThumb(); } catch (e) { toast('保存領域を開けません(プライベートブラウズ中?)'); }
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (_) {}
  if (cfg.level || cfg.steady) {
    if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) { cfg.level = cfg.steady = false; saveCfg(); syncUI(); syncSettings(); }   // iPadOSはセンサー許可にユーザー操作が必要なので起動時はOFFに戻す
    else { LV.perm = true; syncMotion(); }
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  await startCamera();
})();
