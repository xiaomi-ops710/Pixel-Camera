'use strict';
/* =====================================================================
   ギャラリー / ビューア(iPadOS「写真」に近い操作感と配置)
   ・ライブラリ: 上部の戻る・タイトル・選択・その他 / 下部のタブ(すべての写真/日)
   ・日付ごとのグループ表示 / 選択時の丸チェック / 下部の操作バー
   ・ビューア: 上部のカプセル(共有・お気に入り / 日時 / 編集・情報・削除・その他)
             下部のフィルムストリップ / タップで UI を隠す / 情報パネル / スライドショー
   ・評価(★1〜5)と非表示。既存データの fav は ★5 として扱う
   ===================================================================== */
const gallery = $('#gallery'), viewer = $('#viewer');
let gItems = [], gSel = new Set(), gSelecting = false;
const G = { view: 'all', filter: 'all' };                       // view: all|day  /  filter: all|photo|video|fav|hidden
const thumbCache = new Map();
const ratingOf = i => (i.rating != null ? i.rating : (i.fav ? 5 : 0));
const favOf = i => ratingOf(i) > 0;
const DOW = ['日', '月', '火', '水', '木', '金', '土'];

function thumbURL(it) {
  if (!it.thumb || !it.thumb.size) return '';
  let u = thumbCache.get(it.id);
  if (!u) { u = URL.createObjectURL(it.thumb); thumbCache.set(it.id, u); }
  return u;
}
function visibleItems() {
  return gItems.filter(i => {
    if (G.filter === 'hidden') return !!i.hidden;
    if (i.hidden) return false;
    if (G.filter === 'photo') return i.type === 'photo';
    if (G.filter === 'video') return i.type === 'video';
    if (G.filter === 'fav') return favOf(i);
    return true;
  });
}
const dayKey = ts => { const d = new Date(ts); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
const dayLabel = ts => { const d = new Date(ts); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${DOW[d.getDay()]}曜日`; };
const hm = ts => { const d = new Date(ts); return `${d.getHours()}:${pad(d.getMinutes())}`; };
function relLabel(ts) {
  const d = new Date(ts), n = new Date();
  const diff = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
  if (diff === 0) return '今日'; if (diff === 1) return '昨日';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
const TITLES = { all: 'すべての写真', photo: '写真', video: 'ビデオ', fav: 'お気に入り', hidden: '非表示' };

/* ---------- 共通: ピルメニュー(iPadOS のポップオーバー風) ---------- */
let menuOff = null;
function closeMenu() {
  const m = $('#menu'); m.hidden = true; m.innerHTML = '';
  if (menuOff) { document.removeEventListener('pointerdown', menuOff, true); menuOff = null; }
}
function openMenu(anchor, items) {
  closeMenu();
  const m = $('#menu');
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'msep'; m.appendChild(s); continue; }
    if (it.row) {
      const r = document.createElement('div'); r.className = 'mrow3';
      it.row.forEach(b => {
        const x = document.createElement('button'); x.innerHTML = `<span class="ms i-${b.icon}"></span><small>${b.label}</small>`;
        x.onclick = () => { closeMenu(); b.onClick(); }; r.appendChild(x);
      });
      m.appendChild(r); continue;
    }
    if (it.stars) {
      const r = document.createElement('div'); r.className = 'mstars';
      for (let k = 1; k <= 5; k++) {
        const s = document.createElement('button');
        s.innerHTML = `<span class="ms i-star${k <= it.stars.value ? ' fill' : ''}"></span>`;
        s.onclick = () => { closeMenu(); it.stars.onPick(k === it.stars.value ? 0 : k); };
        r.appendChild(s);
      }
      m.appendChild(r); continue;
    }
    const b = document.createElement('button');
    b.className = 'mitem' + (it.danger ? ' danger' : '');
    b.innerHTML = `<span class="ms i-${it.icon || 'circle'}"></span><span class="ml">${it.label}</span>${it.check ? '<span class="ms i-check mchk"></span>' : ''}`;
    b.onclick = () => { closeMenu(); if (it.onClick) it.onClick(); };
    m.appendChild(b);
  }
  m.hidden = false;
  const r = anchor.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
  let x = Math.min(r.right - mw, innerWidth - mw - 12), y = r.bottom + 8;
  if (y + mh > innerHeight - 12) y = Math.max(12, r.top - mh - 8);
  m.style.left = Math.max(12, x) + 'px'; m.style.top = Math.max(12, y) + 'px';
  m.classList.remove('in'); void m.offsetWidth; m.classList.add('in');
  setTimeout(() => {
    menuOff = e => { if (m.contains(e.target)) return; closeMenu(); };
    document.addEventListener('pointerdown', menuOff, true);
  }, 0);
}

/* =====================================================================
   ライブラリ
   ===================================================================== */
async function openGallery() { show(gallery); await refreshGallery(); }
async function refreshGallery() {
  gItems = (await DB.list()).sort((a, b) => cfg.gsort === 'asc' ? a.ts - b.ts : b.ts - a.ts);
  renderGallery();
}
// 年別 / 月別 / すべての写真(=日ごとの見出し)でグループ化
function groupBy(list, mode) {
  const out = [];
  for (const it of list) {
    const d = new Date(it.ts);
    const k = mode === 'year' ? d.getFullYear() : mode === 'month' ? d.getFullYear() * 100 + d.getMonth() + 1 : dayKey(it.ts);
    const label = mode === 'year' ? `${d.getFullYear()}年` : mode === 'month' ? `${d.getFullYear()}年${d.getMonth() + 1}月` : dayLabel(it.ts);
    const last = out[out.length - 1];
    if (last && last.k === k) last.items.push(it); else out.push({ k, label, items: [it] });
  }
  return out;
}
function cellFor(it, idx) {
  const c = document.createElement('button');
  c.className = 'cell' + (gSel.has(it.id) ? ' sel' : '');
  c.style.setProperty('--i', Math.min(idx, 30));
  const img = new Image(); img.alt = ''; img.decoding = 'async';
  const u = thumbURL(it); if (u) img.src = u; c.appendChild(img);
  if (it.type === 'video') { const d = document.createElement('span'); d.className = 'vdur'; d.innerHTML = `<span class="ms i-videocam"></span>${fmtDur(it.dur || 0)}`; c.appendChild(d); }
  if (favOf(it)) { const f = document.createElement('span'); f.className = 'ms fill fv i-star'; c.appendChild(f); }
  const ck = document.createElement('span'); ck.className = 'ck'; ck.innerHTML = '<span class="ms i-check"></span>'; c.appendChild(ck);
  let lp = 0, fired = false;
  c.addEventListener('pointerdown', () => { fired = false; clearTimeout(lp); lp = setTimeout(() => { fired = true; gSelecting = true; gSel.add(it.id); renderGallery(); }, 480); });
  ['pointerup', 'pointerleave', 'pointercancel', 'pointermove'].forEach(ev => c.addEventListener(ev, () => clearTimeout(lp)));
  c.onclick = () => {
    if (fired) { fired = false; return; }
    if (gSelecting) { gSel.has(it.id) ? gSel.delete(it.id) : gSel.add(it.id); c.classList.toggle('sel', gSel.has(it.id)); updateBars(); }
    else openViewer(visibleItems().indexOf(it));
  };
  return c;
}
function renderGallery() {
  const grid = $('#g-grid'); grid.innerHTML = ''; grid.classList.toggle('selecting', gSelecting);
  const list = visibleItems();
  $('#g-empty').hidden = list.length > 0;
  const groups = groupBy(list, G.view);
  const frag = document.createDocumentFragment(); let idx = 0;
  for (const g of groups) {
    if (g.label) { const h = document.createElement('div'); h.className = 'g-head'; h.textContent = g.label; frag.appendChild(h); }
    const row = document.createElement('div'); row.className = 'g-row';
    for (const it of g.items) row.appendChild(cellFor(it, idx++));
    frag.appendChild(row);
  }
  grid.appendChild(frag);
  updateBars();
}
function updateBars() {
  const n = gSel.size, total = visibleItems().length;
  $('#g-title-t').textContent = TITLES[G.filter];
  $('#g-total').textContent = gSelecting ? (n ? `${n}枚を選択` : '項目を選択') : `${total}枚`;
  $('#g-actions').hidden = !gSelecting;
  $('#g-tabs').hidden = gSelecting;
  $('#g-select').textContent = gSelecting ? '完了' : '選択';
  $('#g-all').hidden = !gSelecting;
  $('#g-all').textContent = n > 0 && n === total ? '選択解除' : 'すべてを選択';
  $('#g-count').textContent = n ? `${n}枚を選択中` : '項目を選択';
  ['#g-share', '#g-fav', '#g-zip', '#g-pdf', '#g-del'].forEach(s => $(s).disabled = n === 0);
  $$('#g-tabs .ptab').forEach(b => b.classList.toggle('sel', b.dataset.g === G.view));
  $('#g-select').classList.toggle('bold', gSelecting);
}
function selectedRecs() { return gItems.filter(i => gSel.has(i.id)); }

$('#btn-gallery').onclick = openGallery;
$('#g-close').onclick = () => { hide(gallery); gSelecting = false; gSel.clear(); closeMenu(); refreshLastThumb(); };
$('#g-select').onclick = () => { gSelecting = !gSelecting; if (!gSelecting) gSel.clear(); renderGallery(); };
$('#g-all').onclick = () => {
  const list = visibleItems();
  if (gSel.size === list.length) gSel.clear(); else list.forEach(i => gSel.add(i.id));
  renderGallery();
};
$$('#g-tabs .ptab').forEach(b => b.onclick = () => { G.view = b.dataset.g; cfg.gview = G.view; saveCfg(); renderGallery(); });
$('#g-more').onclick = () => {
  openMenu($('#g-more'), [
    { label: '新しい順', icon: 'swap-vert', check: cfg.gsort !== 'asc', onClick: () => { cfg.gsort = 'desc'; saveCfg(); refreshGallery(); } },
    { label: '古い順', icon: 'swap-vert', check: cfg.gsort === 'asc', onClick: () => { cfg.gsort = 'asc'; saveCfg(); refreshGallery(); } },
    { sep: true },
    { label: 'すべての写真', icon: 'photo-library', check: G.filter === 'all', onClick: () => setFilter('all') },
    { label: '写真', icon: 'photo', check: G.filter === 'photo', onClick: () => setFilter('photo') },
    { label: 'ビデオ', icon: 'videocam', check: G.filter === 'video', onClick: () => setFilter('video') },
    { label: 'お気に入り', icon: 'star', check: G.filter === 'fav', onClick: () => setFilter('fav') },
    { label: '非表示', icon: 'visibility-off', check: G.filter === 'hidden', onClick: () => setFilter('hidden') },
    { sep: true },
    { label: '選択', icon: 'check-circle', onClick: () => { gSelecting = true; renderGallery(); } }
  ]);
};
function setFilter(f) { G.filter = f; gSel.clear(); renderGallery(); }

/* ---------- 選択時の操作 ---------- */
$('#g-share').onclick = () => shareRecs(selectedRecs());
$('#g-fav').onclick = async () => {
  const recs = selectedRecs(); if (!recs.length) return;
  const to = recs.every(r => favOf(r)) ? 0 : 5;
  for (const r of recs) { r.rating = to; r.fav = to > 0; await DB.put(r); }
  renderGallery(); toast(to ? `${recs.length}件をお気に入りに追加` : `${recs.length}件のお気に入りを解除`);
};
$('#g-zip').onclick = async () => {
  const recs = selectedRecs(); if (!recs.length) return;
  if (recs.reduce((a, r) => a + r.size, 0) > 800e6) return toast('合計が大きすぎます。800MB以下ずつに分けてください', 4000);
  try {
    toast('ZIPを作成中…', 120000);
    const blob = await buildZip(recs, (i, n) => toast(`ZIPを作成中… ${i}/${n}`, 120000));
    toast('ZIPを作成しました');
    await shareFiles([new File([blob], `silentcam_${stamp(Date.now()).slice(0, 15)}.zip`, { type: 'application/zip' })]);
  } catch (e) { toast('ZIP作成に失敗しました: ' + (e.message || e), 4000); }
};
$('#g-del').onclick = async () => {
  const ids = [...gSel]; if (!ids.length) return;
  if (await dialog({ title: `${ids.length}件を削除`, text: 'この端末内の撮影データから完全に削除します。写真Appなどに書き出したコピーは消えません。', ok: '削除' })) {
    await DB.del(ids); gSel.clear(); await refreshGallery(); toast('削除しました');
  }
};

/* =====================================================================
   ビューア
   ===================================================================== */
let vList = [], vIdx = 0, vUrl = null, chromeOn = true, slideT = 0, lastTapV = 0, pendTap = 0;
const V = { s: 1, x: 0, y: 0 };
const isSlideshow = () => slideT !== 0;

async function openViewer(idx) {
  vList = visibleItems();
  if (!vList.length) return;
  vIdx = clamp(idx < 0 ? 0 : idx, 0, vList.length - 1);
  show(viewer); setChrome(true);
  await loadViewer(0);
}
function setChrome(on) { chromeOn = on; viewer.classList.toggle('chrome-off', !on); }
async function loadViewer(dir = 0) {
  const it = vList[vIdx]; if (!it) { closeViewer(); return; }
  $('#v-date').textContent = relLabel(it.ts); $('#v-time').textContent = hm(it.ts);
  $('#v-fav').classList.toggle('fav', favOf(it));
  $('#v-fav .ms').className = 'ms i-star' + (favOf(it) ? ' fill' : '');
  $('#v-edit').hidden = it.type === 'video';
  const blob = await DB.blob(it.id);
  if (!blob) { toast('画像を読み込めません'); return; }
  if (vList[vIdx] !== it) return;                              // 読み込み中に移動した場合は捨てる
  if (vUrl) URL.revokeObjectURL(vUrl);
  vUrl = URL.createObjectURL(blob);
  const st = $('#vstage'); st.innerHTML = ''; V.s = 1; V.x = V.y = 0;
  st.className = dir < 0 ? 'l' : dir > 0 ? 'r' : '';
  let el;
  if (it.type === 'video') { el = document.createElement('video'); el.controls = true; el.playsInline = true; el.src = vUrl; }
  else { el = new Image(); el.src = vUrl; el.draggable = false; }
  st.appendChild(el);
  renderFilmstrip();
  if (!$('#v-info-panel').hidden) fillInfo(it);
}
function renderFilmstrip() {
  const s = $('#v-strip'); s.innerHTML = '';
  const from = Math.max(0, vIdx - 40), to = Math.min(vList.length, vIdx + 41);
  for (let i = from; i < to; i++) {
    const it = vList[i], b = document.createElement('button');
    b.className = 'fs' + (i === vIdx ? ' cur' : '');
    const im = new Image(); const u = thumbURL(it); if (u) im.src = u; b.appendChild(im);
    b.onclick = () => { if (i !== vIdx) { const dir = i > vIdx ? 1 : -1; vIdx = i; loadViewer(dir); } };
    s.appendChild(b);
  }
  const cur = s.querySelector('.cur'); if (cur) cur.scrollIntoView({ inline: 'center', block: 'nearest' });
}
function closeViewer() {
  stopSlideshow(); closeInfo(); closeMenu();
  hide(viewer); $('#vstage').innerHTML = '';
  if (vUrl) { URL.revokeObjectURL(vUrl); vUrl = null; }
  refreshGallery();
}
const vStep = d => { const n = vIdx + d; if (n >= 0 && n < vList.length) { vIdx = n; loadViewer(d); } };
$('#v-close').onclick = closeViewer;
$('#v-prev').onclick = () => vStep(-1); $('#v-next').onclick = () => vStep(1);
$('#v-share').onclick = () => shareRecs([vList[vIdx]]);

async function setRating(it, n) {
  it.rating = n; it.fav = n > 0; await DB.put(it);
  if (vList[vIdx] === it) { $('#v-fav').classList.toggle('fav', n > 0); $('#v-fav .ms').className = 'ms i-star' + (n > 0 ? ' fill' : ''); }
  toast(n ? `評価 ${n}` : '評価を解除', 1100);
}
$('#v-fav').onclick = () => { const it = vList[vIdx]; if (it) setRating(it, favOf(it) ? 0 : 5); };

$('#v-del').onclick = async () => {
  const it = vList[vIdx]; if (!it) return;
  if (await dialog({ title: '削除', text: `${it.name} をこの端末内から削除します。`, ok: '削除' })) {
    await DB.del([it.id]); vList.splice(vIdx, 1);
    if (!vList.length) closeViewer(); else { vIdx = Math.min(vIdx, vList.length - 1); loadViewer(0); }
    toast('削除しました');
  }
};

/* ---------- 情報パネル ---------- */
function fillInfo(it) {
  const kind = it.type === 'video' ? `ビデオ · ${fmtDur(it.dur || 0)}`
    : it.name.includes('_scan') ? 'スキャン補正' : it.name.includes('_enh') ? '補正コピー' : '写真';
  $('#vi-date').textContent = `${dayLabel(it.ts)} ${hm(it.ts)}`;
  $('#vi-name').textContent = it.name;
  $('#vi-kind').textContent = kind;
  $('#vi-spec').textContent = `${it.w} × ${it.h} px · ${(it.w * it.h / 1e6).toFixed(1)} MP · ${fmtBytes(it.size)}`;
  $('#vi-stars').innerHTML = [1, 2, 3, 4, 5].map(k => `<span class="ms i-star${k <= ratingOf(it) ? ' fill' : ''}"></span>`).join('');
  $('#vi-hide').textContent = it.hidden ? '再表示する' : '非表示にする';
}
function closeInfo() { const p = $('#v-info-panel'); if (p.hidden) return; p.classList.remove('in'); p.hidden = true; }
$('#v-info').onclick = () => {
  const p = $('#v-info-panel'); if (!p.hidden) return closeInfo();
  fillInfo(vList[vIdx]); p.hidden = false; p.classList.remove('in'); void p.offsetWidth; p.classList.add('in');
};
$('#vi-close').onclick = closeInfo;
$('#vi-rate').onclick = () => { const it = vList[vIdx]; openMenu($('#vi-rate'), [{ stars: { value: ratingOf(it), onPick: n => setRating(it, n) } }]); };
$('#vi-hide').onclick = () => toggleHidden(vList[vIdx]);

async function toggleHidden(it) {
  if (!it) return;
  it.hidden = !it.hidden; await DB.put(it);
  toast(it.hidden ? '非表示にしました' : '再表示しました', 1300);
  const keep = vList[vIdx];
  vList = visibleItems();
  if (!vList.length) return closeViewer();
  vIdx = clamp(vList.indexOf(keep) >= 0 ? vList.indexOf(keep) : vIdx, 0, vList.length - 1);
  if (vList[vIdx] !== keep) { loadViewer(0); } else { fillInfo(keep); }
}

/* ---------- その他メニュー ---------- */
async function copyImage(it) {
  try {
    if (it.type !== 'photo') return toast('ビデオはコピーできません');
    const blob = await DB.blob(it.id);
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
    const png = await toBlob(c, 'image/png');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast('写真をコピーしました');
  } catch (e) { toast('この環境ではコピーできません'); }
}
async function duplicateItem(it) {
  const blob = await DB.blob(it.id);
  const { id, ...rest } = it;
  await DB.add({ ...rest, name: it.name.replace(/(\.[^.]+)$/, '_copy$1'), ts: it.ts + 1, hidden: false, thumb: it.thumb }, blob);
  await refreshGallery(); toast('複製しました');
}
$('#v-more').onclick = () => {
  const it = vList[vIdx]; if (!it) return;
  openMenu($('#v-more'), [
    { row: [
      { icon: 'content-copy', label: 'コピー', onClick: () => copyImage(it) },
      { icon: 'library-add', label: '複製', onClick: () => duplicateItem(it) },
      { icon: 'visibility-off', label: it.hidden ? '再表示' : '非表示', onClick: () => toggleHidden(it) }
    ] },
    { sep: true },
    { label: '評価を設定', icon: 'star', onClick: () => openMenu($('#v-more'), [{ stars: { value: ratingOf(it), onPick: n => setRating(it, n) } }]) },
    { label: 'スライドショーを開始', icon: 'slideshow', onClick: startSlideshow },
    { sep: true },
    { label: '共有', icon: 'share', onClick: () => shareRecs([it]) },
    { label: '写真Appへ保存', icon: 'download', onClick: async () => downloadFiles([await recToFile(it)]) },
    { label: '情報', icon: 'info', onClick: () => $('#v-info').click() }
  ]);
};

/* ---------- スライドショー ---------- */
function startSlideshow() {
  if (!vList.length) return;
  closeInfo(); setChrome(false); viewer.classList.add('slideshow');
  slideT = setInterval(() => {
    if (vIdx < vList.length - 1) { vIdx++; loadViewer(1); } else stopSlideshow();
  }, 3500);
}
function stopSlideshow() {
  if (!slideT) return;
  clearInterval(slideT); slideT = 0; viewer.classList.remove('slideshow'); setChrome(true);
}

/* ---------- キーボード ---------- */
document.addEventListener('keydown', e => {
  if (!viewer.classList.contains('open')) return;
  if (e.key === 'ArrowLeft') vStep(-1);
  else if (e.key === 'ArrowRight') vStep(1);
  else if (e.key === 'Escape') { if (!$('#menu').hidden) closeMenu(); else if (isSlideshow()) stopSlideshow(); else closeViewer(); }
});

/* ---------- ジェスチャ(ピンチ拡大 / スワイプ送り / 1回タップで UI 切替 / 2回タップで拡大) ---------- */
(() => {
  const st = $('#vstage'), ptrs = new Map(); let pinch = null, drag = null;
  const img = () => st.querySelector('img');
  const apply = () => { const i = img(); if (i) i.style.transform = `translate(${V.x}px,${V.y}px) scale(${V.s})`; };
  const dist = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  st.addEventListener('pointerdown', e => {
    if (isSlideshow()) { stopSlideshow(); return; }
    if (e.target.tagName === 'VIDEO') return;
    st.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) { pinch = { d: dist(), s: V.s }; drag = null; }
    else drag = { x: e.clientX, y: e.clientY, vx: V.x, vy: V.y, t: performance.now(), moved: false };
  });
  st.addEventListener('pointermove', e => {
    if (!ptrs.has(e.pointerId)) return; ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2 && pinch) { V.s = clamp(pinch.s * dist() / pinch.d, 1, 12); apply(); }
    else if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 8) drag.moved = true;
      if (V.s > 1.01) { V.x = drag.vx + dx; V.y = drag.vy + dy; apply(); }
    }
  });
  const up = e => {
    if (drag && ptrs.size === 1) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y, dt = performance.now() - drag.t;
      if (V.s <= 1.01 && Math.abs(dx) > 70 && Math.abs(dy) < 70 && dt < 600) vStep(dx < 0 ? 1 : -1);
      else if (!drag.moved && dt < 300) {
        if (performance.now() - lastTapV < 320) {                  // 2回タップ: 拡大/戻す
          clearTimeout(pendTap); V.s = V.s > 1.01 ? 1 : 2.5; V.x = V.y = 0; apply(); lastTapV = 0;
        } else {
          lastTapV = performance.now(); clearTimeout(pendTap);
          pendTap = setTimeout(() => setChrome(!chromeOn), 280);  // 1回タップ: UI の表示切替
        }
      }
    }
    ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (!ptrs.size) drag = null;
    if (V.s <= 1.01) { V.s = 1; V.x = V.y = 0; apply(); }
  };
  st.addEventListener('pointerup', up);
  st.addEventListener('pointercancel', e => { ptrs.delete(e.pointerId); pinch = drag = null; });
})();

/* =====================================================================
   共有・ZIP(既存の処理を流用)
   ===================================================================== */
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
};/* ---------- 共有 / ダウンロード ---------- */
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
