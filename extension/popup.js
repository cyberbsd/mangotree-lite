const $ = (s) => document.querySelector(s);
const S = chrome.storage.local;
const get = async (k, d) => (await S.get(k))[k] ?? d;
const STATUS = { open: '可訂', upcoming: '未開', closed: '已截止', unknown: '' };
const fmt = (iso) => iso ? new Date(iso).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', weekday: 'narrow', hour: '2-digit', minute: '2-digit', hour12: false }) : '?';
let DATA, current;

async function load() {
  const menu = await get('menu');
  const [favorites, orders, pending, settings] = await Promise.all([get('favorites', []), get('orders', []), get('pending'), get('settings', {})]);
  if (!menu) { $('#meta').textContent = '尚無菜單，抓取中（約 1–2 分鐘）…'; chrome.runtime.sendMessage({ type: 'scrape' }, () => load()); return; }
  const now = Date.now();
  const slots = Object.values(menu.slots).map((s) => ({ ...s, status: MTParse.slotStatus(s, now) })).sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.meal.localeCompare(b.meal));
  DATA = { slots, favorites, orders: orders.slice(-10).reverse(), pending, settings: { ...MT.defaults, ...settings } };
  $('#meta').textContent = `菜單 ${fmt(menu.scrapedAt)} · 提醒 ${DATA.settings.remindMeals.join(',')} · 截止前 ${DATA.settings.minutesBeforeClose} 分${DATA.settings.autoSubmit ? ' · 自動送出' : ''}`;
  const keep = current && slots.find((s) => s.key === current.key);
  current = keep || slots.find((s) => s.status === 'open' && s.meal === 'lunch') || slots.find((s) => s.status === 'open') || slots.find((s) => s.status === 'upcoming') || slots[0];
  renderTabs(); render();
}
function renderTabs() {
  $('#tabs').innerHTML = DATA.slots.map((s) => `<div class="tab ${s === current ? 'active' : ''}" data-k="${s.key}">${s.mealLabel} ${s.date ? s.date.slice(5).replace('-', '/') : ''}(${s.dayZh}) ${STATUS[s.status]}</div>`).join('');
  $('#tabs').querySelectorAll('.tab').forEach((t) => (t.onclick = () => { current = DATA.slots.find((s) => s.key === t.dataset.k); renderTabs(); render(); }));
}
const isFav = (v, it) => DATA.favorites.some((f) => f.vendorId === v.id && f.itemName === it.name);
function itemRow(v, it, inFav) {
  const o = { vendorId: v.id, vendorName: v.name, vendorUrl: v.url, itemId: it.id, itemName: it.name, price: it.price };
  const enc = encodeURIComponent(JSON.stringify(o));
  const soldOut = it.qty === 0 || v.soldOut, can = current.status === 'open' && !soldOut && !DATA.pending;
  return `<div class="item"><span class="n">${inFav ? v.name + ' · ' : ''}${it.name} <span class="q">${soldOut ? '售完' : it.qty != null ? '剩' + it.qty : ''}</span></span><span class="p">${it.priceLabel || ''}</span><button class="star" data-fav="${enc}">${isFav(v, it) ? '★' : '☆'}</button><button class="primary" data-order="${enc}" ${can ? '' : 'disabled'}>訂</button></div>`;
}
function render() {
  const s = current; if (!s) { $('#main').innerHTML = '<div class="empty">沒有菜單資料</div>'; return; }
  let html = `<div class="banner ${s.status}">${s.mealLabel} ${s.date || ''}（${s.dayZh}）${STATUS[s.status]} · ${fmt(s.window.from)} → ${fmt(s.window.until)}</div>`;
  if (DATA.pending) html += `<div class="banner upcoming">訂單進行中：${DATA.pending.itemName}（${DATA.pending.stage}）<button class="sm" id="cancel">取消</button><div class="log">${(DATA.pending.log || []).slice(-3).join('\n')}</div></div>`;
  const favs = DATA.favorites.map((f) => { const v = s.vendors.find((v) => v.id === f.vendorId || v.name === f.vendorName); const it = v && v.items.find((i) => i.name === f.itemName); return it ? { v, it } : null; }).filter(Boolean);
  if (favs.length) html += `<div class="card fav"><div class="vendor">⭐ 常點</div><div class="items">${favs.map(({ v, it }) => itemRow(v, it, true)).join('')}</div></div>`;
  html += s.vendors.map((v) => `<div class="card" data-v="${v.id}"><div class="vendor"><span>${v.name} <small>${v.priceRange || ''}${v.quantity != null ? ' · 剩' + v.quantity : ''}</small></span><span>${v.items.length}項 ▾</span></div><div class="items">${v.items.map((it) => itemRow(v, it)).join('') || '<div class="q">（無法讀取品項）</div>'}</div></div>`).join('');
  if (DATA.orders.length) html += `<div class="card"><div class="vendor">最近訂單</div>${DATA.orders.slice(0, 5).map((o) => `<div class="q">${fmt(o.at)} ${o.date || ''} ${o.itemName} ×${o.qty || 1} ${o.submitted ? '✅' : '⏳'}</div>`).join('')}</div>`;
  const wasOpen = new Set([...$('#main').querySelectorAll('.card.open[data-v]')].map((c) => c.dataset.v));
  $('#main').innerHTML = html;
  $('#main').querySelectorAll('.card[data-v]').forEach((c) => wasOpen.has(c.dataset.v) && c.classList.add('open'));
  $('#main').querySelectorAll('.card .vendor').forEach((h) => (h.onclick = () => h.parentElement.classList.toggle('open')));
  $('#main').querySelectorAll('[data-fav]').forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation(); const f = JSON.parse(decodeURIComponent(b.dataset.fav));
    const i = DATA.favorites.findIndex((x) => x.vendorId === f.vendorId && x.itemName === f.itemName);
    if (i >= 0) DATA.favorites.splice(i, 1); else DATA.favorites.unshift(f);
    await S.set({ favorites: DATA.favorites }); render();
  }));
  $('#main').querySelectorAll('[data-order]').forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation(); const o = JSON.parse(decodeURIComponent(b.dataset.order));
    const qty = 1;
    b.disabled = true; b.textContent = '…';
    chrome.runtime.sendMessage({ type: 'order', ...o, qty, slotKey: current.key, date: current.date }, () => window.close());
  }));
  const c = $('#cancel'); if (c) c.onclick = async () => { await S.remove('pending'); load(); };
}
$('#refresh').onclick = () => { $('#meta').textContent = '抓取中…'; chrome.runtime.sendMessage({ type: 'scrape' }, () => load()); };
$('#opts').onclick = () => chrome.runtime.openOptionsPage();
chrome.storage.onChanged.addListener((c) => { if (c.menu || c.pending || c.orders) load(); });
load();
