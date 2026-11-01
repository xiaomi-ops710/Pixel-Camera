'use strict';
/* =====================================================================
   追加機能(app.js の後に読み込み、app.js のグローバルを利用する)
   ・フォーカスピーキング(ピントが合った輪郭を黄色で表示)
   ・スキャン補正: 台形補正 / 自動枠検出 / 見開き分割 / 影除去・白黒化
   ・複数枚をPDFにまとめる(JPEGを再圧縮せずそのまま埋め込み)
   ===================================================================== */

/* ---------- フォーカスピーキング ---------- */
const PK = { timer: 0, c: document.createElement('canvas'), x: null, ov: null };
function syncPeak() {
  const cv = $('#peak');
  clearInterval(PK.timer); PK.timer = 0;
  cv.hidden = !cfg.peak;
  if (cfg.peak) PK.timer = setInterval(drawPeak, 180);
}
function drawPeak() {
  if (document.hidden || !cfg.peak || !video.videoWidth || !track) return;
  const p = cropParams(), W = 480, H = Math.max(8, Math.round(W * p.sh / p.sw)), c = PK.c;
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; PK.x = c.getContext('2d', { willReadFrequently: true }); }
  PK.x.imageSmoothingQuality = 'medium';
  PK.x.drawImage(video, p.sx, p.sy, p.sw, p.sh, 0, 0, W, H);
  const d = PK.x.getImageData(0, 0, W, H).data, n = W * H, g = new Float32Array(n);
  for (let i = 0; i < n; i++) g[i] = d[i * 4] * .299 + d[i * 4 + 1] * .587 + d[i * 4 + 2] * .114;
  const mag = new Uint8Array(n), hist = new Uint32Array(256);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x, m = Math.min(255, Math.abs(4 * g[i] - g[i - 1] - g[i + 1] - g[i - W] - g[i + W]) * .5) | 0;
    mag[i] = m; hist[m]++;
  }
  let acc = 0, th = 0; const target = n * .035;               // 上位3.5%の鋭い輪郭だけを表示
  for (let t = 255; t > 0; t--) { acc += hist[t]; if (acc >= target) { th = t; break; } }
  th = Math.max(th, 22);                                        // 平坦な部分は何も出さない
  const cv = $('#peak');
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; PK.ov = null; }
  if (!PK.ov) PK.ov = cv.getContext('2d');
  const img = PK.ov.createImageData(W, H), o = img.data;
  for (let i = 0; i < n; i++) if (mag[i] >= th) { o[i * 4] = 255; o[i * 4 + 1] = 213; o[i * 4 + 2] = 79; o[i * 4 + 3] = 235; }
  PK.ov.putImageData(img, 0, 0);
  cv.style.transform = cfg.facing === 'user' ? 'scaleX(-1)' : '';
}
syncPeak();

/* =====================================================================
   画像処理: 透視変換(台形補正)/ 枠の自動検出 / 補正フィルタ
   ===================================================================== */
// 単位正方形 → 四角形(TL,TR,BR,BL)の射影変換係数(Heckbert)
function quadMap(q) {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  let a, b, c, d, e, f, g, h;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    a = p1.x - p0.x; b = p2.x - p1.x; c = p0.x; d = p1.y - p0.y; e = p2.y - p1.y; f = p0.y; g = h = 0;
  } else {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / den; h = (dx1 * dy3 - dx3 * dy1) / den;
    a = p1.x - p0.x + g * p1.x; b = p3.x - p0.x + h * p3.x; c = p0.x;
    d = p1.y - p0.y + g * p1.y; e = p3.y - p0.y + h * p3.y; f = p0.y;
  }
  return { a, b, c, d, e, f, g, h };
}
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// src(canvas)上の四角形 q(px座標)を長方形に展開。出力は元の解像度を保ち、maxPix を超える時だけ縮小
async function warpQuad(src, q, maxPix) {
  let W = Math.max(dist2(q[0], q[1]), dist2(q[3], q[2])), H = Math.max(dist2(q[0], q[3]), dist2(q[1], q[2]));
  const k = Math.min(1, Math.sqrt(maxPix / (W * H)));
  W = Math.max(8, Math.round(W * k)); H = Math.max(8, Math.round(H * k));
  const sw = src.width, sh = src.height;
  const s = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const octx = out.getContext('2d'), od = octx.createImageData(W, H), o = od.data, m = quadMap(q);
  for (let y = 0; y < H; y++) {
    const v = (y + .5) / H;
    for (let x = 0; x < W; x++) {
      const u = (x + .5) / W, den = m.g * u + m.h * v + 1;
      const px = (m.a * u + m.b * v + m.c) / den - .5, py = (m.d * u + m.e * v + m.f) / den - .5;
      let x0 = Math.floor(px), y0 = Math.floor(py);
      const fx = px - x0, fy = py - y0;
      let x1 = x0 + 1, y1 = y0 + 1;
      x0 = x0 < 0 ? 0 : x0 >= sw ? sw - 1 : x0; x1 = x1 < 0 ? 0 : x1 >= sw ? sw - 1 : x1;
      y0 = y0 < 0 ? 0 : y0 >= sh ? sh - 1 : y0; y1 = y1 < 0 ? 0 : y1 >= sh ? sh - 1 : y1;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy, oi = (y * W + x) * 4;
      o[oi] = s[i00] * w00 + s[i10] * w10 + s[i01] * w01 + s[i11] * w11;
      o[oi + 1] = s[i00 + 1] * w00 + s[i10 + 1] * w10 + s[i01 + 1] * w01 + s[i11 + 1] * w11;
      o[oi + 2] = s[i00 + 2] * w00 + s[i10 + 2] * w10 + s[i01 + 2] * w01 + s[i11 + 2] * w11;
      o[oi + 3] = 255;
    }
    if ((y & 127) === 127) await sleep(0);                      // 画面を固めない
  }
  octx.putImageData(od, 0, 0);
  return out;
}

// 影除去: 紙の地色(ブロック内の最大輝度)を推定し、ムラを割り算で均して白に揃える
function flatField(c, mode) {
  const w = c.width, h = c.height, x = c.getContext('2d', { willReadFrequently: true });
  const img = x.getImageData(0, 0, w, h), d = img.data;
  const B = Math.max(8, Math.round(Math.min(w, h) / 48)), bw = Math.ceil(w / B), bh = Math.ceil(h / B);
  let bg = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let mx = 0; const y1 = Math.min(h, (by + 1) * B), x1 = Math.min(w, (bx + 1) * B);
    for (let yy = by * B; yy < y1; yy += 2) for (let xx = bx * B; xx < x1; xx += 2) {
      const i = (yy * w + xx) * 4, l = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; if (l > mx) mx = l;
    }
    bg[by * bw + bx] = mx;
  }
  for (let pass = 0; pass < 2; pass++) {                        // 3x3平滑化(文字ブロックの落ち込みを均す)
    const nb = new Float32Array(bg.length);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = by + dy, xx = bx + dx; if (yy < 0 || xx < 0 || yy >= bh || xx >= bw) continue; s += bg[yy * bw + xx]; n++;
      }
      nb[by * bw + bx] = s / n;
    }
    bg = nb;
  }
  const lut = new Uint8Array(256); for (let i = 0; i < 256; i++) lut[i] = Math.round(255 * Math.pow(i / 255, mode === 'bw' ? 1 : 1.18));
  const xi0 = new Int32Array(w), xi1 = new Int32Array(w), xf = new Float32Array(w);
  for (let xx = 0; xx < w; xx++) { const gx = Math.min(bw - 1, Math.max(0, xx / B - .5)), i0 = Math.floor(gx); xi0[xx] = i0; xi1[xx] = Math.min(bw - 1, i0 + 1); xf[xx] = gx - i0; }
  for (let y = 0; y < h; y++) {
    const gy = Math.min(bh - 1, Math.max(0, y / B - .5)), j0 = Math.floor(gy), j1 = Math.min(bh - 1, j0 + 1), fy = gy - j0;
    for (let xx = 0; xx < w; xx++) {
      const fx = xf[xx], L = (bg[j0 * bw + xi0[xx]] * (1 - fx) + bg[j0 * bw + xi1[xx]] * fx) * (1 - fy) + (bg[j1 * bw + xi0[xx]] * (1 - fx) + bg[j1 * bw + xi1[xx]] * fx) * fy;
      const sc = 255 / Math.max(L, 60), i = (y * w + xx) * 4;
      let r = d[i] * sc, g = d[i + 1] * sc, b = d[i + 2] * sc;
      r = r > 255 ? 255 : r; g = g > 255 ? 255 : g; b = b > 255 ? 255 : b;
      if (mode === 'shadow') { d[i] = lut[r | 0]; d[i + 1] = lut[g | 0]; d[i + 2] = lut[b | 0]; }
      else {
        const l = (r * .299 + g * .587 + b * .114) | 0;
        let v;
        if (mode === 'bw') { const t = Math.min(1, Math.max(0, (l - 105) / 85)); v = Math.round(255 * t * t * (3 - 2 * t)); }   // なめらかな二値化(文字の縁を保つ)
        else v = lut[l];
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
  }
  x.putImageData(img, 0, 0);
}
async function applyFilter(c, mode) {
  if (mode === 'none') return;
  await sleep(20);
  if (mode === 'levels') enhanceCanvas(c, false); else flatField(c, mode);
}

// 資料の枠を自動検出(大津の二値化 → 最大の連結領域 → 4隅)
function largestComp(g, W, H, th, pol) {
  const n = W * H, seen = new Uint8Array(n), st = new Int32Array(n); let best = null;
  const fg = j => pol ? g[j] > th : g[j] <= th;
  for (let s = 0; s < n; s++) {
    if (seen[s] || !fg(s)) continue;
    let sp = 0; st[sp++] = s; seen[s] = 1;
    const c = { area: 0, tl: null, tr: null, br: null, bl: null, a: 1e9, b: -1e9, cc: -1e9, dd: 1e9 };
    while (sp) {
      const i = st[--sp], x = i % W, y = (i / W) | 0, sm = x + y, df = x - y; c.area++;
      if (sm < c.a) { c.a = sm; c.tl = [x, y]; } if (sm > c.b) { c.b = sm; c.br = [x, y]; }
      if (df > c.cc) { c.cc = df; c.tr = [x, y]; } if (df < c.dd) { c.dd = df; c.bl = [x, y]; }
      if (x > 0 && !seen[i - 1] && fg(i - 1)) { seen[i - 1] = 1; st[sp++] = i - 1; }
      if (x < W - 1 && !seen[i + 1] && fg(i + 1)) { seen[i + 1] = 1; st[sp++] = i + 1; }
      if (y > 0 && !seen[i - W] && fg(i - W)) { seen[i - W] = 1; st[sp++] = i - W; }
      if (y < H - 1 && !seen[i + W] && fg(i + W)) { seen[i + W] = 1; st[sp++] = i + W; }
    }
    if (!best || c.area > best.area) best = c;
  }
  return best;
}
function polyArea(q) { let a = 0; for (let i = 0; i < 4; i++) { const p = q[i], r = q[(i + 1) % 4]; a += p.x * r.y - r.x * p.y; } return Math.abs(a) / 2; }
function defaultQuad() { const m = .04; return [{ x: m, y: m }, { x: 1 - m, y: m }, { x: 1 - m, y: 1 - m }, { x: m, y: 1 - m }]; }
function detectQuad(cv) {
  const W = 320, H = Math.max(8, Math.round(W * cv.height / cv.width)), n = W * H;
  const t = document.createElement('canvas'); t.width = W; t.height = H;
  const x = t.getContext('2d', { willReadFrequently: true }); x.drawImage(cv, 0, 0, W, H);
  const d = x.getImageData(0, 0, W, H).data, g = new Uint8Array(n), h = new Uint32Array(256);
  for (let i = 0; i < n; i++) { g[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8; h[g[i]]++; }
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * h[i];
  let sB = 0, wB = 0, best = 0, th = 128;
  for (let i = 0; i < 256; i++) {
    wB += h[i]; if (!wB) continue; const wF = n - wB; if (!wF) break;
    sB += i * h[i]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; th = i; }
  }
  for (const pol of [1, 0]) {                                   // 明るい紙 → ダメなら暗い紙
    const r = largestComp(g, W, H, th, pol); if (!r) continue;
    const frac = r.area / n;
    if (pol && frac >= .97) return null;                        // 画面いっぱいの紙 → 全体を使う
    if (frac < .12 || frac >= .97) continue;
    const q = [r.tl, r.tr, r.br, r.bl].map(p => ({ x: (p[0] + .5) / W, y: (p[1] + .5) / H }));
    if (polyArea(q) > .1) return q;
  }
  return null;
}
const splitQuads = q => {
  const mt = { x: (q[0].x + q[1].x) / 2, y: (q[0].y + q[1].y) / 2 }, mb = { x: (q[3].x + q[2].x) / 2, y: (q[3].y + q[2].y) / 2 };
  return [[q[0], mt, mb, q[3]], [mt, q[1], q[2], mb]];
};
function makeRot(img, rot, maxLong) {
  const iw = img.width, ih = img.height, sc = Math.min(1, maxLong / Math.max(iw, ih));
  const w = Math.round(iw * sc), h = Math.round(ih * sc), c = document.createElement('canvas'), odd = rot % 2;
  c.width = odd ? h : w; c.height = odd ? w : h;
  const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
  x.translate(c.width / 2, c.height / 2); x.rotate(rot * Math.PI / 2); x.drawImage(img, -w / 2, -h / 2, w, h);
  return c;
}

/* =====================================================================
   スキャン補正エディタ
   ===================================================================== */
const E = { item: null, bmp: null, rot: 0, prev: null, q: null, spread: false, filter: 'shadow', pv: false, replace: false, busy: false, drag: null, tok: 0, vw: 1, vh: 1 };
const editor = $('#editor');

(() => {                                                        // 4隅ハンドルを生成
  const hs = $('#ed-hs'), NS = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < 4; i++) {
    const g = document.createElementNS(NS, 'g'); g.dataset.i = i;
    const v = document.createElementNS(NS, 'circle'); v.setAttribute('class', 'vis'); v.setAttribute('r', 12);
    const t = document.createElementNS(NS, 'circle'); t.setAttribute('class', 'hit'); t.setAttribute('r', 36);
    g.append(v, t); hs.appendChild(g);
  }
})();

async function openEditor(it) {
  const blob = await DB.blob(it.id); if (!blob) return toast('画像を読み込めません');
  let bmp; try { bmp = await createImageBitmap(blob); } catch (e) { return toast('画像を開けません'); }
  Object.assign(E, { item: it, bmp, rot: 0, spread: false, pv: false, replace: false, busy: false });
  E.prev = makeRot(bmp, 0, 1400);
  E.q = detectQuad(E.prev) || defaultQuad();
  show(editor); syncEditorUI(); await renderEditor();
  if (E.q.every((p, i) => Math.abs(p.x - defaultQuad()[i].x) < 1e-6 && Math.abs(p.y - defaultQuad()[i].y) < 1e-6)) toast('枠を自動検出できませんでした。4隅をドラッグして合わせてください', 3500);
}
function closeEditor() { hide(editor); if (E.bmp && E.bmp.close) E.bmp.close(); E.bmp = null; E.prev = null; }

function syncEditorUI() {
  $$('#ed-filter button').forEach(b => b.classList.toggle('sel', b.dataset.v === E.filter));
  $('#ed-pv').classList.toggle('sel', E.pv); $('#ed-spread').classList.toggle('sel', E.spread); $('#ed-replace').classList.toggle('sel', E.replace);
  $('#ed-save-t').textContent = E.spread ? '2ページに分けて保存' : '保存';
  $('#ed-replace').hidden = E.spread;
}
function layoutEditor() {
  const st = $('#ed-stage'), cv = $('#ed-canvas'), w = $('#ed-wrap');
  const sw = st.clientWidth - 16, sh = st.clientHeight - 16; if (sw <= 0 || sh <= 0) return;
  const k = Math.min(sw / cv.width, sh / cv.height), W = Math.max(1, Math.floor(cv.width * k)), H = Math.max(1, Math.floor(cv.height * k));
  w.style.width = W + 'px'; w.style.height = H + 'px';
  $('#ed-svg').setAttribute('viewBox', `0 0 ${W} ${H}`); E.vw = W; E.vh = H;
  drawOverlay();
}
function drawOverlay() {
  if (!E.q) return;
  const W = E.vw, H = E.vh, P = E.q.map(p => [p.x * W, p.y * H]);
  $('#ed-poly').setAttribute('points', P.map(p => p.join(',')).join(' '));
  const mid = $('#ed-mid');
  if (E.spread) {
    mid.style.display = '';
    mid.setAttribute('x1', (P[0][0] + P[1][0]) / 2); mid.setAttribute('y1', (P[0][1] + P[1][1]) / 2);
    mid.setAttribute('x2', (P[3][0] + P[2][0]) / 2); mid.setAttribute('y2', (P[3][1] + P[2][1]) / 2);
  } else mid.style.display = 'none';
  $$('#ed-hs g').forEach((g, i) => g.setAttribute('transform', `translate(${P[i][0]} ${P[i][1]})`));
}
async function renderEditor() {
  const tok = ++E.tok, cv = $('#ed-canvas'), x = cv.getContext('2d');
  if (!E.prev) return;
  if (!E.pv) {
    cv.width = E.prev.width; cv.height = E.prev.height; x.drawImage(E.prev, 0, 0); $('#ed-svg').style.display = '';
  } else {
    const outs = [];
    for (const nq of (E.spread ? splitQuads(E.q) : [E.q])) {
      const q = nq.map(p => ({ x: p.x * E.prev.width, y: p.y * E.prev.height }));
      const o = await warpQuad(E.prev, q, 1.6e6); await applyFilter(o, E.filter); outs.push(o);
      if (tok !== E.tok || !E.prev) return;
    }
    const gap = outs.length > 1 ? 8 : 0, W = outs.reduce((a, o) => a + o.width, 0) + gap, H = Math.max(...outs.map(o => o.height));
    cv.width = W; cv.height = H; x.fillStyle = '#111'; x.fillRect(0, 0, W, H);
    let ox = 0; outs.forEach(o => { x.drawImage(o, ox, 0); ox += o.width + gap; });
    $('#ed-svg').style.display = 'none';
  }
  layoutEditor();
}
window.addEventListener('resize', () => { if (editor.classList.contains('open')) layoutEditor(); });

// 4隅のドラッグ(指で隠れないよう、掴んだ位置のズレを保持)
$('#ed-hs').addEventListener('pointerdown', e => {
  const g = e.target.closest('g[data-i]'); if (!g) return;
  const i = +g.dataset.i, r = $('#ed-svg').getBoundingClientRect();
  E.drag = { i, g, ox: E.q[i].x * r.width - (e.clientX - r.left), oy: E.q[i].y * r.height - (e.clientY - r.top) };
  g.classList.add('drag'); try { e.target.setPointerCapture(e.pointerId); } catch (_) {} e.preventDefault();
});
$('#ed-hs').addEventListener('pointermove', e => {
  if (!E.drag) return; const r = $('#ed-svg').getBoundingClientRect();
  E.q[E.drag.i] = { x: clamp((e.clientX - r.left + E.drag.ox) / r.width, 0, 1), y: clamp((e.clientY - r.top + E.drag.oy) / r.height, 0, 1) };
  drawOverlay();
});
['pointerup', 'pointercancel'].forEach(ev => $('#ed-hs').addEventListener(ev, () => { if (E.drag) { E.drag.g.classList.remove('drag'); E.drag = null; } }));

$('#ed-close').onclick = closeEditor;
$('#ed-auto').onclick = () => {
  const q = detectQuad(E.prev); E.q = q || defaultQuad(); drawOverlay();
  toast(q ? '枠を自動検出しました' : '自動検出できませんでした。4隅をドラッグしてください', 2200);
  if (E.pv) renderEditor();
};
$('#ed-full').onclick = () => { E.q = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]; drawOverlay(); if (E.pv) renderEditor(); };
$('#ed-rot').onclick = () => {
  E.rot = (E.rot + 1) % 4; E.prev = makeRot(E.bmp, E.rot, 1400);
  const T = p => ({ x: 1 - p.y, y: p.x }), o = E.q;                 // 90°右回転: 点を回し、TL/TR/BR/BLの並びを振り直す
  E.q = [T(o[3]), T(o[0]), T(o[1]), T(o[2])];
  renderEditor();
};
$$('#ed-filter button').forEach(b => b.onclick = () => { E.filter = b.dataset.v; syncEditorUI(); if (E.pv) renderEditor(); });
$('#ed-pv').onclick = () => { E.pv = !E.pv; syncEditorUI(); renderEditor(); };
$('#ed-spread').onclick = () => { E.spread = !E.spread; syncEditorUI(); if (E.pv) renderEditor(); else drawOverlay(); };
$('#ed-replace').onclick = () => { E.replace = !E.replace; syncEditorUI(); };
$('#v-edit').onclick = () => { const it = vList[vIdx]; if (it && it.type === 'photo') openEditor(it); };

$('#ed-save').onclick = async () => {
  if (E.busy || !E.bmp) return; E.busy = true; $('#ed-save').disabled = true;
  try {
    toast('処理中…(元の解像度で補正しています)', 120000); await sleep(30);
    const full = makeRot(E.bmp, E.rot, Infinity), pages = [];
    for (const nq of (E.spread ? splitQuads(E.q) : [E.q])) {
      const q = nq.map(p => ({ x: p.x * full.width, y: p.y * full.height }));
      const out = await warpQuad(full, q, 20e6); await applyFilter(out, E.filter); pages.push(out);
    }
    let base = E.item.name.replace(/\.[^.]+$/, '').replace(/_(scan[LR]?|enh)(_\d+)?$/, '');
    const taken = new Set(gItems.map(i => i.name)), t0 = Date.now(), metas = [];
    for (let i = 0; i < pages.length; i++) {
      const c = pages[i], blob = await toBlob(c, 'image/jpeg', Math.max(cfg.quality, .95));
      if (!blob) throw new Error('書き出しに失敗しました');
      const thumb = await makeThumb(c, { sx: 0, sy: 0, sw: c.width, sh: c.height });
      const suf = pages.length > 1 ? (i ? '_scanR' : '_scanL') : '_scan';
      let name = `${base}${suf}.jpg`, k = 2; while (taken.has(name)) name = `${base}${suf}_${k++}.jpg`; taken.add(name);
      metas.push(await DB.add({ type: 'photo', ts: t0 + i, fav: !!E.item.fav, name, w: c.width, h: c.height, size: blob.size, mime: 'image/jpeg', thumb }, blob));
    }
    if (E.replace && !E.spread) await DB.del([E.item.id]);
    closeEditor(); await refreshGallery(); refreshLastThumb();
    vList = visibleItems(); const k = vList.findIndex(i => i.id === metas[0].id);
    vIdx = k >= 0 ? k : clamp(vIdx, 0, Math.max(0, vList.length - 1)); await loadViewer();
    toast(metas.length > 1 ? '2ページに分けて保存しました' : 'スキャン補正を保存しました');
  } catch (e) { toast('保存に失敗しました: ' + (e.message || e), 4000); }
  E.busy = false; $('#ed-save').disabled = false;
};

/* =====================================================================
   PDF書き出し(JPEGをそのまま埋め込み。撮影順=ページ順)
   ===================================================================== */
async function buildPdf(recs, onProgress) {
  const enc = new TextEncoder(), parts = [], offs = []; let off = 0;
  const put = d => { const u = typeof d === 'string' ? enc.encode(d) : d; parts.push(u); off += u.length; };
  const nP = recs.length, pageId = i => 3 + i * 3, contId = i => 4 + i * 3, imgId = i => 5 + i * 3, total = 3 + nP * 3;
  put(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));   // %PDF-1.4 + バイナリ印
  offs[1] = off; put('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  offs[2] = off; put(`2 0 obj\n<< /Type /Pages /Count ${nP} /Kids [${recs.map((_, i) => pageId(i) + ' 0 R').join(' ')}] >>\nendobj\n`);
  for (let i = 0; i < nP; i++) {
    const r = recs[i]; let blob = await DB.blob(r.id), w = r.w, h = r.h;
    if (r.mime !== 'image/jpeg') {                              // PNG等はJPEG(高品質)へ
      const bmp = await createImageBitmap(blob), c = document.createElement('canvas'); c.width = w = bmp.width; c.height = h = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0); if (bmp.close) bmp.close(); blob = await toBlob(c, 'image/jpeg', .95);
    }
    const jpg = new Uint8Array(await blob.arrayBuffer()), pw = (w * .24).toFixed(2), ph = (h * .24).toFixed(2);   // 300dpi換算
    offs[pageId(i)] = off; put(`${pageId(i)} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${imgId(i)} 0 R >> >> /Contents ${contId(i)} 0 R >>\nendobj\n`);
    const cs = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    offs[contId(i)] = off; put(`${contId(i)} 0 obj\n<< /Length ${cs.length} >>\nstream\n${cs}\nendstream\nendobj\n`);
    offs[imgId(i)] = off; put(`${imgId(i)} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
    put(jpg); put('\nendstream\nendobj\n');
    if (onProgress) onProgress(i + 1, nP);
    await sleep(0);
  }
  const xref = off; let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) x += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  put(x + `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
$('#g-pdf').onclick = async () => {
  const recs = gItems.filter(i => gSel.has(i.id) && i.type === 'photo').sort((a, b) => a.ts - b.ts);
  if (!recs.length) return toast('写真を選択してください');
  if (recs.reduce((a, r) => a + r.size, 0) > 600e6) return toast('合計が大きすぎます。600MB以下ずつに分けてください', 4000);
  try {
    toast('PDFを作成中…', 120000);
    const blob = await buildPdf(recs, (i, n) => toast(`PDFを作成中… ${i}/${n}`, 120000));
    toast(`PDFを作成しました(${recs.length}ページ / ${fmtBytes(blob.size)})`);
    await shareFiles([new File([blob], `silentcam_${stamp(Date.now()).slice(0, 15)}.pdf`, { type: 'application/pdf' })]);
  } catch (e) { toast('PDF作成に失敗しました: ' + (e.message || e), 4000); }
};
