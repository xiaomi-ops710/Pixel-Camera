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
  prefix: 'IMG', enhance: false, enhMode: 'levels', steady: false, dim: 0, anim: true,
  seq: false, seqN: 1, peak: false, gsort: 'desc',
  topBar: { cap: true, grid: false, level: false, peak: false, enh: false, dim: false, silent: true, res: true },
  aspect: 'full', auto: 'off', autoSens: 'mid', autoInt: 5, autoMax: 30, histo: false, zebra: false, dtap: false, autoScan: false, scanFilter: 'shadow'
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
  aeLocked = false; updateLockUI(); setupExposure(caps); if (window.buildAdjust) buildAdjust(caps);
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
  const ta = targetAspect(vw, vh);
  // 写真(フル)とビデオは画面いっぱいに表示(映像は cover で埋める)。切り出し比率のときは枠内に収める
  const fill = !ta;
  viewport.classList.toggle('fill', fill);
  let w, h;
  if (fill) { w = stage.clientWidth; h = stage.clientHeight; }
  else {
    const cw = stage.clientWidth - 20, ch = stage.clientHeight - 20;
    w = cw; h = cw / ta;
    if (h > ch) { h = ch; w = ch * ta; }
  }
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

let lastTapT = 0;
function tapFocus(e) {
  panelShow(false);
  const nowT = performance.now();
  if (cfg.dtap && nowT - lastTapT < 320) { lastTapT = 0; triggerShutter(); return; }
  lastTapT = nowT;
  if (aeLocked) return;
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
const ASPECTS = { full: 0, '3:2': 1.5, '16:9': 16 / 9, '1:1': 1, a4: Math.SQRT2 };
// 撮影範囲の縦横比(長辺/短辺を、端末の向き=映像の向きに合わせて適用)。null=カメラそのまま
function targetAspect(vw, vh) {
  if (cfg.mode === 'square') return 1;
  if (isVideoMode()) return null;
  const k = ASPECTS[cfg.aspect]; if (!k) return null;
  return vw >= vh ? k : 1 / k;
}
function cropParams() {
  const vw = video.videoWidth, vh = video.videoHeight;
  let bx = 0, by = 0, bw = vw, bh = vh;
  const ta = targetAspect(vw, vh);
  if (ta) { if (vw / vh > ta) { bw = Math.round(vh * ta); bh = vh; } else { bw = vw; bh = Math.round(vw / ta); } bx = Math.round((vw - bw) / 2); by = Math.round((vh - bh) / 2); }
  const d = digital();
  const mir = cfg.facing === 'user';
  const fxs = mir ? 1 - fx : fx;
  const cw = Math.round(bw / d), ch = Math.round(bh / d);
  const sx = clamp(Math.round(bx + fxs * bw - cw / 2), 0, vw - cw);
  const sy = clamp(Math.round(by + fy * bh - ch / 2), 0, vh - ch);
  const fit = cfg.zoomOut === 'fit' && d > 1.0001;
  return { sx, sy, sw: cw, sh: ch, ow: fit ? bw : cw, oh: fit ? bh : ch, mirror: mir && cfg.mirror };
}
async function snapshot(noSeq) {
  const p = cropParams(); let bmp;
  try { bmp = await createImageBitmap(video); }
  catch (_) { const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight; c.getContext('2d').drawImage(video, 0, 0); bmp = c; }
  const seq = cfg.seq && !noSeq ? cfg.seqN++ : 0; if (seq) saveCfg();
  return { bmp, p, ts: Date.now(), seq };
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
async function saveEnhanced(c, ts, seq) {
  enhanceCanvas(c, cfg.enhMode === 'gray');
  const blob = await toBlob(c, 'image/jpeg', Math.max(cfg.quality, .95)); if (!blob) return;
  const thumb = await makeThumb(c, { sx: 0, sy: 0, sw: c.width, sh: c.height });
  const meta = { type: 'photo', ts: ts + 1, fav: false, name: `${fileBase('IMG')}${seq ? pad(seq, 4) : stamp(ts)}_enh.jpg`, w: c.width, h: c.height, size: blob.size, mime: 'image/jpeg', thumb };
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
  const meta = { type: 'photo', ts, fav: false, name: `${fileBase('IMG')}${s.seq ? pad(s.seq, 4) : stamp(ts)}.${png ? 'png' : 'jpg'}`, w: p.ow, h: p.oh, size: blob.size, mime: type, thumb };
  const saved = await DB.add(meta, blob);
  if (cfg.enhance) { try { const en = await saveEnhanced(c, ts, s.seq); if (en) saved.pairId = en.id; } catch (e) { toast('補正コピーの保存に失敗しました'); } }
  if (cfg.autoScan && window.autoScanCopy) { try { const sc = await autoScanCopy(c, s); if (sc) saved.pairId2 = sc.id; } catch (e) { toast('自動スキャン補正に失敗しました'); } }
  return saved;
}
// 保存キュー(1本ずつ処理しメモリ消費を抑える)
let lastShot = null, undoT = 0;
function showUndo(m) {
  lastShot = m; const b = $('#undo-chip'); b.hidden = false; b.classList.remove('in'); void b.offsetWidth; b.classList.add('in');
  clearTimeout(undoT); undoT = setTimeout(() => b.hidden = true, 5000);
}
$('#undo-chip').onclick = async () => {
  if (!lastShot) return; const ids = [lastShot.id, lastShot.pairId, lastShot.pairId2].filter(Boolean); lastShot = null; $('#undo-chip').hidden = true;
  try { await DB.del(ids); await refreshLastThumb(); toast('直前の撮影を削除しました', 1800); } catch (e) { toast('削除に失敗しました'); }
};
const encQ = []; let encBusy = false, pending = 0;
function updatePending() { $('#pending-chip').hidden = pending === 0; $('#pending-n').textContent = pending; }
function enqueue(s) { encQ.push(s); pending++; updatePending(); pump(); }
async function pump() {
  if (encBusy) return; encBusy = true;
  while (encQ.length) {
    const s = encQ.shift();
    try { const sv = await encodeAndSave(s); setThumb(sv); if (!burstRunning) showUndo(sv); }
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
  burstRunning = true; app.classList.add('bursting'); $('#undo-chip').hidden = true;
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
  if (!isVideoMode() && cfg.auto && cfg.auto !== 'off' && window.autoToggle) return autoToggle();
  if (isVideoMode()) return toggleRecord();
  if (cfg.burstMode) return burstRunning ? (burstRunning = false) : burstLoop();
  return shootWithTimer();
}
/* ---------- シャッターボタン ---------- */
(() => {
  const sh = $('#shutter'); let holdT = null, held = false, down = false;
  sh.addEventListener('pointerdown', e => {
    e.preventDefault(); down = true; held = false;
    if (isVideoMode() || cfg.burstMode || (cfg.auto && cfg.auto !== 'off')) return;
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
let rec = null, recChunks = [], recStart = 0, recTimer = null, recThumb = null, recPausedAt = 0, recPausedTotal = 0;
const recElapsed = () => (Date.now() - recStart - recPausedTotal - (recPausedAt ? Date.now() - recPausedAt : 0)) / 1000;
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
  try { recThumb = await snapshot(true); } catch (_) { recThumb = null; }
  rec.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
  rec.onstop = finalizeRecord;
  rec.start(1000);
  recording = true; recStart = Date.now(); recPausedAt = 0; recPausedTotal = 0; $('#btn-pause').hidden = false; $('#undo-chip').hidden = true;
  app.classList.add('recording'); $('#btn-snap').hidden = false; $('#rec-chip').hidden = false;
  $('#rec-time').textContent = '0:00';
  recTimer = setInterval(() => $('#rec-time').textContent = fmtDur(recElapsed()), 500);
}
function stopRecord() { if (rec && rec.state !== 'inactive') rec.stop(); }
async function finalizeRecord() {
  clearInterval(recTimer);
  const dur = recElapsed(); $('#btn-pause').hidden = true; recPausedAt = 0;
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

/* ---------- モード切替のアニメーション(プレビューのぼかし→鮮明化、シャッターの変形、ラベルの跳ね) ---------- */
function playModeAnim() {
  const a = $('#app'); a.classList.remove('mode-anim'); void a.offsetWidth; a.classList.add('mode-anim');
  clearTimeout(playModeAnim.t); playModeAnim.t = setTimeout(() => a.classList.remove('mode-anim'), 950);
}

/* ---------- 各ボタン ---------- */
function syncUI() {
  app.dataset.mode = cfg.mode;
  syncTopBar();
  $$('#modes .mode').forEach(b => b.classList.toggle('sel', b.dataset.mode === cfg.mode));
  $('#btn-burst').classList.toggle('on', cfg.burstMode);
  $('#btn-burst').hidden = isVideoMode();
  const tm = $('#btn-timer'); tm.classList.toggle('on', cfg.timer > 0); tm.hidden = isVideoMode();
  tm.querySelector('.ms').className = 'ms ' + (cfg.timer ? 'i-timer' : 'i-timer-off');
  $('#timer-sub').textContent = cfg.timer ? cfg.timer : '';
  $('#btn-grid').classList.toggle('on', cfg.grid); $('#gridlines').hidden = !cfg.grid;
  $('#btn-level').classList.toggle('on', cfg.level); $('#level').hidden = !cfg.level;
  $('#btn-enh').classList.toggle('on', cfg.enhance); $('#btn-peak').classList.toggle('on', cfg.peak); if (window.syncPeak) syncPeak(); if (window.syncCap) syncCap();
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
  if (!reduceMotion()) playModeAnim();
  if (prevVideo !== isVideoMode()) await startCamera();
});
$('#btn-burst').onclick = () => { cfg.burstMode = !cfg.burstMode; saveCfg(); syncUI(); toast(cfg.burstMode ? '連写モード: シャッターで開始/停止' : '連写モードOFF(シャッター長押しで連写)'); };
$('#btn-timer').onclick = () => { cfg.timer = { 0: 3, 3: 10, 10: 0 }[cfg.timer] || 0; saveCfg(); syncUI(); };
let flipRot = 0;
$('#btn-flip').onclick = async () => { if (recording) return; flipRot += 180; $('#btn-flip .ms').style.transform = `rotate(${flipRot}deg)`; cfg.facing = cfg.facing === 'user' ? 'environment' : 'user'; zoom = 1; fx = fy = .5; saveCfg(); animateFlip(); await startCamera(); };
$('#btn-grid').onclick = () => { cfg.grid = !cfg.grid; saveCfg(); syncUI(); };
$('#btn-level').onclick = () => toggleLevel(!cfg.level);
$('#btn-peak').onclick = () => { cfg.peak = !cfg.peak; saveCfg(); syncUI(); syncSettings(); };
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

/* ---------- 最後に撮った写真のサムネ(ギャラリーは gallery.js) ---------- */
async function refreshLastThumb() {
  try {
    const l = (await DB.list()).sort((a, b) => b.ts - a.ts)[0];
    const img = $('#thumb'); if (img.dataset.url) { URL.revokeObjectURL(img.dataset.url); img.dataset.url = ''; }
    if (l && l.thumb && l.thumb.size) setThumb(l); else { img.removeAttribute('src'); $('#btn-gallery').classList.remove('has'); }
  } catch (_) {}
}

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
$$('#settings input[type=checkbox][data-key]').forEach(el => el.onchange = () => applyKey(el.dataset.key, el.checked));
$$('#settings input[type=text]').forEach(el => el.oninput = () => applyKey(el.dataset.key, el.dataset.key === 'seqN' ? Math.max(1, parseInt(el.value, 10) || 1) : (el.value.trim() || 'IMG')));
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
   更新の検出と適用
   ・起動のたびに sw.js を確認(HTTPキャッシュを使わない)
   ・新しい版が見つかったら、撮影中でない時に自動で読み直す(撮影を邪魔しない)
   ===================================================================== */
const APP_VERSION = 'v15';
let pendingReload = false;
function busyNow() { return recording || burstRunning || AS.on || !!countdownTimer || (editor && editor.classList.contains('open')); }
function applyPendingReload() {
  if (!pendingReload) return;
  if (busyNow()) { setTimeout(applyPendingReload, 1500); return; }
  location.reload();
}
function setupUpdates() {
  $('#s-ver').textContent = APP_VERSION;
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    const check = () => reg.update().catch(() => {});
    check();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    setInterval(check, 30 * 60 * 1000);
    if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    reg.addEventListener('updatefound', () => {
      const w = reg.installing; if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) w.postMessage({ type: 'SKIP_WAITING' });
      });
    });
  }).catch(() => {});
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }     // 初回インストール時は再読み込み不要
    pendingReload = true; toast('新しいバージョンに更新しています…', 1800);
    setTimeout(applyPendingReload, 800);
  });
}

/* =====================================================================
   起動
   ===================================================================== */
(async function init() {
  syncSettings(); syncUI();
  if (document.fonts && document.fonts.load) Promise.all(['Material Symbols Outlined', 'SC Outlined'].map(f => document.fonts.load(`24px "${f}"`, '\ue429').catch(() => []))).then(r => { if (!r.some(a => a.length)) toast('アイコンフォントを読み込めませんでした。ページを再読み込みしてください', 5000); });
  try { await DB.open(); await refreshLastThumb(); } catch (e) { toast('保存領域を開けません(プライベートブラウズ中?)'); }
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (_) {}
  if (cfg.level || cfg.steady) {
    if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) { cfg.level = cfg.steady = false; saveCfg(); syncUI(); syncSettings(); }   // iPadOSはセンサー許可にユーザー操作が必要なので起動時はOFFに戻す
    else { LV.perm = true; syncMotion(); }
  }
  setupUpdates();
  await startCamera();
})();

/* 設定: 連続する行を iOS「設定」風のグループ(角丸の面)にまとめる */
(() => {
  const panel = $('#settings .panel'); if (!panel) return;
  let grp = null;
  [...panel.children].forEach(el => {
    if (el.classList.contains('row')) {
      if (!grp) { grp = document.createElement('div'); grp.className = 'grp'; el.before(grp); }
      grp.appendChild(el);
    } else grp = null;
  });
})();

/* スライダーの青い塗り幅(--p)を値に合わせて更新 */
(() => {
  const upd = el => el.style.setProperty('--p', ((el.value - el.min) / ((el.max - el.min) || 1) * 100) + '%');
  const all = () => document.querySelectorAll('input[type=range]');
  all().forEach(el => { upd(el); el.addEventListener('input', () => upd(el)); });
  setInterval(() => all().forEach(upd), 300);   // スクリプトから値が変わった時も追随
})();

/* ---------- 上部バーのボタンを設定で選択(表示・非表示) ---------- */
function topItems() { return { cap: '#btn-cap', grid: '#btn-grid', level: '#btn-level', peak: '#btn-peak', enh: '#btn-enh', dim: '#btn-dim', silent: '#chip-silent', res: '#chip-res' }; }
function topBarOf() { return { ...DEF.topBar, ...(cfg.topBar || {}) }; }
function syncTopBar() {
  const tb = topBarOf();
  const items = topItems();
  for (const k in items) {
    const el = $(items[k]); if (!el) continue;
    const hide = !tb[k];
    if (el.hidden !== hide) el.hidden = hide;   // 状態が変わった時だけ切り替え(出現アニメーションが再生される)
  }
  $$('#settings [data-top]').forEach(cb => { cb.checked = !!tb[cb.dataset.top]; });
}
// 設定の切替は委任で受ける(行の並べ替え・再生成があっても確実に反応する)
$('#settings').addEventListener('change', e => {
  const cb = e.target.closest ? e.target.closest('[data-top]') : null; if (!cb) return;
  cfg.topBar = { ...topBarOf(), [cb.dataset.top]: cb.checked }; saveCfg(); syncTopBar();
});

/* ---------- カメラ反転のアニメーション(Y軸回転+ぼかし) ---------- */
function animateFlip() {
  if (reduceMotion() || !viewport.animate) return;
  viewport.animate([
    { transform: 'perspective(1400px) rotateY(0deg)', opacity: 1, filter: 'blur(0px)' },
    { transform: 'perspective(1400px) rotateY(90deg) scale(.94)', opacity: .15, filter: 'blur(12px)', offset: .5 },
    { transform: 'perspective(1400px) rotateY(0deg)', opacity: 1, filter: 'blur(0px)' }
  ], { duration: 700, easing: 'cubic-bezier(.2,0,0,1)' });
}
