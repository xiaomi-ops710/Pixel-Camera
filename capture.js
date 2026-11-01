'use strict';
/* =====================================================================
   撮影機能(app.js / scan.js の後に読み込む)
   ・撮影オプション(アスペクト比、自動撮影、ヒストグラム/白飛び警告)
   ・自動撮影: ページ自動(めくって動きが止まったら撮影)/ インターバル
   ・カメラ調整(端末が対応している項目だけ表示)
   ・ビデオの一時停止 / 撮影と同時のスキャン補正コピー
   ===================================================================== */
const CM = $('#capmenu');

/* ---------- メニュー開閉 ---------- */
$('#btn-cap').onclick = () => CM.classList.toggle('show');
document.addEventListener('pointerdown', e => {
  if (!CM.classList.contains('show') || e.target.closest('#capmenu') || e.target.closest('#btn-cap')) return;
  CM.classList.remove('show');
}, true);

function applyCap(k, v) {
  cfg[k] = v; saveCfg();
  if (k === 'auto' || k === 'autoSens' || k === 'autoInt' || k === 'autoMax') autoStop();
  if (k === 'aspect') { layout(); updateResChip(); }
  syncCap();
}
$$('#capmenu .seg').forEach(seg => $$('button', seg).forEach(b => b.onclick = () => {
  const raw = b.dataset.v; applyCap(seg.dataset.key, /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw);
}));
$$('#capmenu input[type=checkbox]').forEach(el => el.onchange = () => applyCap(el.dataset.key, el.checked));

function syncCap() {
  $$('#capmenu .seg').forEach(seg => $$('button', seg).forEach(b => b.classList.toggle('sel', b.dataset.v === String(cfg[seg.dataset.key]))));
  $$('#capmenu input[type=checkbox]').forEach(el => el.checked = !!cfg[el.dataset.key]);
  $('#cm-page').hidden = cfg.auto !== 'page'; $('#cm-int').hidden = cfg.auto !== 'interval';
  $('#cm-hint').textContent = {
    off: 'シャッターを押すと1枚撮影します。',
    page: 'iPadをスタンドなどで固定してシャッターで開始。ページをめくって動きが止まると、自動で撮影します。もう一度押すと停止。',
    interval: 'シャッターで開始し、一定間隔で自動撮影します。もう一度押すと停止。'
  }[cfg.auto] || '';
  $('#btn-cap').classList.toggle('on', cfg.aspect !== 'full' || cfg.auto !== 'off' || cfg.histo || cfg.zebra);
  $('#histo').hidden = !cfg.histo; $('#zebra').hidden = !cfg.zebra;
  if (isVideoMode() && AS.on) autoStop();
  syncAnalyze();
}

/* =====================================================================
   自動撮影
   ===================================================================== */
const AS = { on: false, run: 0, state: 'moving', timer: 0, c: document.createElement('canvas'), x: null, prev: null, ref: null, still: 0, n: 0, busy: false, last: 0 };
const SENS = { low: { move: 9, still: 2.4, ref: 6 }, mid: { move: 6, still: 1.7, ref: 4 }, high: { move: 4, still: 1.2, ref: 2.5 } };

function grabGray() {                                           // プレビュー範囲を64px幅のグレーで取得
  if (!video.videoWidth) return null;
  const p = cropParams(), W = 64, H = Math.max(8, Math.round(W * p.sh / p.sw)), c = AS.c;
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; AS.x = c.getContext('2d', { willReadFrequently: true }); AS.prev = null; }
  AS.x.drawImage(video, p.sx, p.sy, p.sw, p.sh, 0, 0, W, H);
  const d = AS.x.getImageData(0, 0, W, H).data, g = new Uint8Array(W * H);
  for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
  return g;
}
const mad = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
function setAutoText(t) { $('#auto-txt').textContent = `${AS.n}枚 · ${t}`; }
async function autoShoot() {
  AS.busy = true;
  try { await shootOnce(); AS.n++; } catch (_) {}
  const chip = $('#auto-chip'); chip.classList.add('shot'); setTimeout(() => chip.classList.remove('shot'), 350);
  AS.busy = false;
}
function autoToggle() { AS.on ? autoStop() : autoStart(); }
function autoStart() {
  if (!stream || AS.on) return;
  Object.assign(AS, { on: true, n: 0, prev: null, ref: null, still: 0, state: 'moving', last: 0, busy: false }); AS.run++;
  app.classList.add('auto-run'); $('#auto-chip').hidden = false; $('#undo-chip').hidden = true; CM.classList.remove('show');
  if (cfg.auto === 'page') { setAutoText('ページを写してください'); AS.timer = setInterval(pageTick, 100); }
  else intervalLoop(AS.run);
}
function autoStop(done) {
  if (!AS.on) return;
  AS.on = false; AS.run++; clearInterval(AS.timer); AS.timer = 0;
  app.classList.remove('auto-run'); $('#auto-chip').hidden = true;
  if (done) toast(`自動撮影が完了しました(${AS.n}枚)`); else if (AS.n) toast(`自動撮影を停止しました(${AS.n}枚)`, 1800);
}
$('#auto-chip').onclick = () => autoStop();

function pageTick() {
  if (!AS.on || AS.busy || document.hidden) return;
  const g = grabGray(); if (!g) return;
  const th = SENS[cfg.autoSens] || SENS.mid;
  if (!AS.prev) { AS.prev = g; return; }
  const diff = mad(g, AS.prev); AS.prev = g;
  if (AS.state === 'idle') {                                    // 待機: 動き(ページをめくる手など)を待つ
    if (diff > th.move) { AS.state = 'moving'; AS.still = 0; setAutoText('動きを検出…'); }
    return;
  }
  if (diff < th.still) AS.still++; else AS.still = 0;           // 動き中: 約0.8秒静止したら確定
  if (AS.still >= 8) {
    AS.still = 0;
    const changed = !AS.ref || mad(g, AS.ref) > th.ref;         // 前回と内容が違う時だけ撮影(同じページの重複防止)
    AS.state = 'idle';
    if (changed && performance.now() - AS.last > 1200) { AS.ref = g; AS.last = performance.now(); autoShoot().then(() => AS.on && setAutoText('次のページをめくってください')); }
    else setAutoText('次のページをめくってください');
  }
}
async function intervalLoop(run) {
  const iv = Math.max(1, Number(cfg.autoInt)) * 1000, t0 = performance.now(); let k = 0;
  while (AS.on && AS.run === run) {
    await autoShoot(); k++;
    if (cfg.autoMax && k >= cfg.autoMax) { autoStop(true); return; }
    const next = t0 + k * iv;
    while (AS.on && AS.run === run && performance.now() < next) {
      setAutoText(`次まで ${Math.ceil((next - performance.now()) / 1000)}秒`); await sleep(Math.min(250, Math.max(10, next - performance.now())));
    }
  }
}

/* =====================================================================
   ヒストグラム / 白飛び警告(ゼブラ)
   ===================================================================== */
const AN = { timer: 0, c: document.createElement('canvas'), x: null, zx: null };
function syncAnalyze() {
  clearInterval(AN.timer); AN.timer = 0;
  if (cfg.histo || cfg.zebra) AN.timer = setInterval(analyze, 220);
}
function analyze() {
  if (document.hidden || !video.videoWidth || !track) return;
  const p = cropParams(), W = 240, H = Math.max(8, Math.round(W * p.sh / p.sw)), c = AN.c;
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; AN.x = c.getContext('2d', { willReadFrequently: true }); }
  AN.x.drawImage(video, p.sx, p.sy, p.sw, p.sh, 0, 0, W, H);
  const d = AN.x.getImageData(0, 0, W, H).data, n = W * H, bins = new Uint32Array(64);
  let zo = null;
  if (cfg.zebra) {
    const z = $('#zebra'); if (z.width !== W || z.height !== H) { z.width = W; z.height = H; AN.zx = null; }
    AN.zx = AN.zx || z.getContext('2d'); zo = AN.zx.createImageData(W, H); z.style.transform = cfg.facing === 'user' ? 'scaleX(-1)' : '';
  }
  let blown = 0, crushed = 0;
  for (let i = 0; i < n; i++) {
    const l = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8; bins[l >> 2]++;
    if (l >= 250) {
      blown++;
      if (zo) { const x = i % W, y = (i / W) | 0; if (((x + y) >> 2) & 1) { const o = i * 4; zo.data[o] = 255; zo.data[o + 1] = 70; zo.data[o + 2] = 60; zo.data[o + 3] = 215; } }
    } else if (l <= 5) crushed++;
  }
  if (zo) AN.zx.putImageData(zo, 0, 0);
  if (cfg.histo) drawHisto(bins, n, blown, crushed);
}
function drawHisto(bins, n, blown, crushed) {
  const x = $('#histo').getContext('2d'); x.clearRect(0, 0, 128, 44);
  let mx = 1; for (const v of bins) if (v > mx) mx = v;
  x.fillStyle = 'rgba(255,213,79,.92)';
  for (let i = 0; i < 64; i++) { const h = Math.round(Math.sqrt(bins[i] / mx) * 36); x.fillRect(i * 2, 39 - h, 2, h); }
  x.fillStyle = crushed / n > .12 ? '#7aa7ff' : 'rgba(255,255,255,.3)'; x.fillRect(0, 41, 26, 3);     // 黒つぶれ
  x.fillStyle = blown / n > .01 ? '#ff5a4d' : 'rgba(255,255,255,.3)'; x.fillRect(102, 41, 26, 3);    // 白飛び
}

/* =====================================================================
   カメラ調整(端末が対応している項目だけを表示)
   ===================================================================== */
const MODE_JA = { continuous: '自動', manual: '手動', 'single-shot': 'ワンショット', none: 'なし' };
const MODE_KEYS = [['whiteBalanceMode', 'ホワイトバランス'], ['exposureMode', '露出'], ['focusMode', 'ピント']];
const NUM_KEYS = [['colorTemperature', '色温度'], ['exposureTime', '露出時間'], ['iso', 'ISO'], ['brightness', '明るさ'], ['contrast', 'コントラスト'], ['saturation', '彩度'], ['sharpness', 'シャープネス'], ['focusDistance', 'ピント距離']];
async function applyAdj(obj) { if (!track) return; try { await track.applyConstraints({ advanced: [obj] }); } catch (e) { toast('この設定は適用できませんでした', 1500); } }
function buildAdjust(caps) {
  const box = $('#cm-adj'); box.innerHTML = '';
  const st = track && track.getSettings ? track.getSettings() : {}, has = (k, v) => Array.isArray(caps[k]) && caps[k].includes(v);
  for (const [k, label] of MODE_KEYS) {
    const vals = caps[k]; if (!Array.isArray(vals) || vals.length < 2) continue;
    const row = document.createElement('div'); row.className = 'mrow';
    const seg = document.createElement('div'); seg.className = 'seg';
    vals.forEach(v => {
      const b = document.createElement('button'); b.textContent = MODE_JA[v] || v; if (st[k] === v) b.classList.add('sel');
      b.onclick = () => { $$('button', seg).forEach(x => x.classList.toggle('sel', x === b)); applyAdj({ [k]: v }); };
      seg.appendChild(b);
    });
    row.innerHTML = `<span>${label}</span>`; row.appendChild(seg); box.appendChild(row);
  }
  for (const [k, label] of NUM_KEYS) {
    const c = caps[k]; if (!c || c.min == null || c.max == null || !(c.max > c.min)) continue;
    const row = document.createElement('label'); row.className = 'mrow';
    const val = st[k] != null ? st[k] : c.min, inp = document.createElement('input'), out = document.createElement('output');
    inp.type = 'range'; inp.min = c.min; inp.max = c.max; inp.step = c.step || (c.max - c.min) / 100; inp.value = val; out.textContent = Math.round(val * 100) / 100;
    inp.oninput = () => {
      const v = parseFloat(inp.value); out.textContent = Math.round(v * 100) / 100;
      const o = { [k]: v };                                     // 手動値を指定する時は、対応するモードも手動へ
      if (k === 'colorTemperature' && has('whiteBalanceMode', 'manual')) o.whiteBalanceMode = 'manual';
      if ((k === 'exposureTime' || k === 'iso') && has('exposureMode', 'manual')) o.exposureMode = 'manual';
      if (k === 'focusDistance' && has('focusMode', 'manual')) o.focusMode = 'manual';
      applyAdj(o);
    };
    row.innerHTML = `<span>${label}</span>`; row.append(inp, out); box.appendChild(row);
  }
  if (!box.children.length) { box.innerHTML = '<p class="none">このカメラ/ブラウザは手動調整に対応していません(iPadのSafariは対応項目が少ないことがあります)。明るさは撮影前に画面タップで調整できます。</p>'; return; }
  const rs = document.createElement('button'); rs.className = 'btn tonal reset'; rs.textContent = '調整をすべて自動に戻す';
  rs.onclick = async () => {
    const o = {}; MODE_KEYS.forEach(([k]) => { if (has(k, 'continuous')) o[k] = 'continuous'; });
    await applyAdj(o); setTimeout(() => { try { buildAdjust(track.getCapabilities()); } catch (_) {} }, 250); toast('自動に戻しました', 1200);
  };
  box.appendChild(rs);
}

/* =====================================================================
   ビデオの一時停止
   ===================================================================== */
function setPauseUI(p) { $('#btn-pause .ms').className = 'ms ' + (p ? 'i-play-arrow' : 'i-pause'); $('#rec-chip').classList.toggle('paused', p); }
$('#btn-pause').onclick = () => {
  if (!rec) return;
  if (rec.state === 'recording') { rec.pause(); recPausedAt = Date.now(); setPauseUI(true); }
  else if (rec.state === 'paused') { rec.resume(); recPausedTotal += Date.now() - recPausedAt; recPausedAt = 0; setPauseUI(false); }
};

/* =====================================================================
   撮影と同時のスキャン補正コピー(紙の枠を自動検出 → 台形補正 → 仕上げフィルタ)
   ===================================================================== */
async function autoScanCopy(c, s) {
  const q = detectQuad(c) || [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const out = await warpQuad(c, q.map(p => ({ x: p.x * c.width, y: p.y * c.height })), 20e6);
  await applyFilter(out, cfg.scanFilter || 'shadow');
  const blob = await toBlob(out, 'image/jpeg', Math.max(cfg.quality, .95)); if (!blob) return null;
  const thumb = await makeThumb(out, { sx: 0, sy: 0, sw: out.width, sh: out.height });
  return DB.add({ type: 'photo', ts: s.ts + 2, fav: false, name: `${fileBase('IMG')}${s.seq ? pad(s.seq, 4) : stamp(s.ts)}_scan.jpg`, w: out.width, h: out.height, size: blob.size, mime: 'image/jpeg', thumb }, blob);
}

syncCap();
