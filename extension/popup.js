const $ = (s) => document.querySelector(s);
const S = chrome.storage.local;
const get = async (k, d) => (await S.get(k))[k] ?? d;
const STATUS = { open: '可訂', upcoming: '未開', closed: '已截止', unknown: '' };
const fmt = (iso) => iso ? new Date(iso).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', weekday: 'narrow', hour: '2-digit', minute: '2-digit', hour12: false }) : '?';
const favKey = (s) => String(s || '').replace(/\s*\$?\s*\d+(\.\d+)?\s*$/, '').replace(/\s+/g, '').trim();
/** Find a favorite/combo line in a slot: vendor by id or name, dish by name ignoring the price suffix. */
const favHit = (slot, f) => { for (const v of slot.vendors) { if (v.id !== f.vendorId && v.name !== f.vendorName) continue; const it = (v.items || []).find((i) => i.name === f.itemName) || (v.items || []).find((i) => favKey(i.name) === favKey(f.itemName)); if (it) return { v, it }; } return null; };
const lineOf = (v, it, qty = 1) => ({ vendorId: v.id, vendorName: v.name, vendorUrl: v.url, itemId: it.id, itemName: it.name, price: it.price, qty });
const same = (a, b) => (a.vendorId === b.vendorId || a.vendorName === b.vendorName) && favKey(a.itemName) === favKey(b.itemName);
const itemOut = (v, it) => it.qty === 0 || !!v.soldOut || !!v.error;
const vendorOut = (v) => !!v.soldOut || !!v.error || (v.items.length > 0 && v.items.every((it) => it.qty === 0));
const sortItems = (v) => [...v.items].sort((a, b) => itemOut(v, a) - itemOut(v, b));
const sortVendors = (vs) => [...vs].sort((a, b) => vendorOut(a) - vendorOut(b));
// Slots are listed in the order they close. Expired ones (cutoff passed, or a past date with no window) are hidden.
const todayTW = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const isExpired = (s) => s.status === 'closed' || (s.status === 'unknown' && (!s.date || s.date < todayTW()));
const closeAt = (s) => (s.window.until ? Date.parse(s.window.until) : s.date ? Date.parse(s.date + 'T23:59:59+08:00') : Infinity);
const orderSlots = (slots) => [...slots].sort((a, b) => closeAt(a) - closeAt(b) || a.meal.localeCompare(b.meal));
/** The slot to act on next: the open one that closes soonest, else the one that opens soonest. */
const pickSlot = (slots) => {
  const live = orderSlots(slots.filter((s) => !isExpired(s)));
  return live.find((s) => s.status === 'open') || live.filter((s) => s.status === 'upcoming').sort((a, b) => Date.parse(a.window.from) - Date.parse(b.window.from))[0] || live[0] || null;
};
let showExpired = false;
let DATA, current;

async function load() {
  const menu = await get('menu');
  const [favorites, combos, basket, orders, pending, settings] = await Promise.all([get('favorites', []), get('combos', []), get('basket', []), get('orders', []), get('pending'), get('settings', {})]);
  if (!menu) { $('#meta').textContent = '尚無菜單，抓取中（約 1 分鐘）…'; chrome.runtime.sendMessage({ type: 'scrape' }, () => load()); return; }
  const now = Date.now();
  const slots = orderSlots(Object.values(menu.slots).map((s) => ({ ...s, status: MTParse.slotStatus(s, now) })));
  // Basket lines for a slot that has expired (or belongs to last week's date) can no longer be ordered.
  const byKey = new Map(slots.map((s) => [s.key, s]));
  const liveBasket = basket.filter((l) => { const sl = byKey.get(l.slotKey); return sl && sl.date === l.date && !isExpired(sl); });
  if (liveBasket.length !== basket.length) { basket.length = 0; basket.push(...liveBasket); await S.set({ basket }); }
  DATA = { slots, favorites, combos, basket, orders: orders.slice(-10).reverse(), pending, settings: { ...MT.defaults, ...settings }, scrapedAt: menu.scrapedAt };
  $('#meta').textContent = `菜單 ${fmt(menu.scrapedAt)} · 提醒 ${DATA.settings.remindMeals.join(',')} · 截止前 ${DATA.settings.minutesBeforeClose} 分${DATA.settings.autoSubmit ? ' · 自動送出' : ''}`;
  const keep = current && slots.find((s) => s.key === current.key);
  current = keep && (showExpired || !isExpired(keep)) ? keep : pickSlot(slots);
  renderTabs(); render(); renderBasket();
}
function renderTabs() {
  const expired = DATA.slots.filter(isExpired), shown = DATA.slots.filter((s) => showExpired || !isExpired(s));
  $('#tabs').innerHTML = shown.map((s) => `<div class="tab ${s === current ? 'active' : ''} ${isExpired(s) ? 'expired' : ''}" data-k="${s.key}">${s.mealLabel} ${s.date ? s.date.slice(5).replace('-', '/') : ''}(${s.dayZh}) ${STATUS[s.status]}</div>`).join('')
    + (expired.length ? `<div class="tab toggle" id="toggle-expired">${showExpired ? '隱藏已截止' : '已截止 ' + expired.length}</div>` : '');
  $('#tabs').querySelectorAll('.tab[data-k]').forEach((t) => (t.onclick = () => { current = DATA.slots.find((s) => s.key === t.dataset.k); renderTabs(); render(); }));
  const tg = $('#toggle-expired'); if (tg) tg.onclick = () => { showExpired = !showExpired; if (!showExpired && current && isExpired(current)) current = pickSlot(DATA.slots); renderTabs(); render(); };
  $('#tabs .tab.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}
const isFav = (v, it) => DATA.favorites.some((f) => same(f, lineOf(v, it)));
const inBasket = (v, it) => DATA.basket.find((b) => same(b, lineOf(v, it)));
const enc = (o) => encodeURIComponent(JSON.stringify(o));

function itemRow(v, it, inFav) {
  const line = lineOf(v, it), soldOut = itemOut(v, it), can = current.status === 'open' && !soldOut;
  const b = inBasket(v, it);
  return `<div class="item ${soldOut ? 'out' : ''}"><span class="n">${inFav ? v.name + ' · ' : ''}${it.name} <span class="q">${soldOut ? '售完' : it.qty != null ? '剩' + it.qty : ''}</span></span><span class="p">${it.priceLabel || ''}</span><button class="star" data-fav="${enc(line)}">${isFav(v, it) ? '★' : '☆'}</button>${b ? `<button class="sm" data-dec="${enc(line)}">−</button><b>${b.qty}</b>` : ''}<button class="primary sm" data-add="${enc(line)}" ${can ? '' : 'disabled'}>＋</button></div>`;
}
function render() {
  const s = current; if (!s) { $('#main').innerHTML = '<div class="empty">目前沒有可訂的時段。<br>新菜單每週六公布，開放時會提醒。</div>'; return; }
  const fresh = s.refreshedAt || s.vendors.map((v) => v.refreshedAt).filter(Boolean).sort().pop();
  let html = `<div class="banner ${s.status}">${s.mealLabel} ${s.date || ''}（${s.dayZh}）${STATUS[s.status]} · ${fmt(s.window.from)} → ${fmt(s.window.until)}<br><span class="q">庫存更新 ${fresh ? fmt(fresh) : fmt(DATA.scrapedAt)}</span> <button class="sm" id="refresh-slot" title="重抓這一天的所有店家">↻ 本日</button></div>`;
  if (DATA.pending) html += `<div class="banner upcoming">下單進行中（${DATA.pending.stage}，${DATA.pending.done || 0}/${DATA.pending.items.length}）<button class="sm" id="cancel">取消</button><div class="log">${(DATA.pending.log || []).slice(-3).join('\n')}</div></div>`;
  // 常點組合: whole baskets saved by name
  if (DATA.combos.length) html += `<div class="card fav"><div class="vendor">🍱 常點組合</div><div class="items">${DATA.combos.map((c, i) => {
    const hits = c.items.map((l) => ({ l, h: favHit(s, l) })); const miss = hits.filter((x) => !x.h).map((x) => x.l.itemName);
    return `<div class="item"><span class="n">${c.name} <span class="q">${c.items.map((l) => `${l.itemName}×${l.qty}`).join('、')}${miss.length ? `<br>⚠ 這天沒有：${miss.join('、')}` : ''}</span></span><button class="sm" data-combo-del="${i}" title="刪除">🗑</button><button class="primary sm" data-combo="${i}" ${s.status === 'open' && miss.length < c.items.length ? '' : 'disabled'}>放入籃子</button></div>`; }).join('')}</div></div>`;
  const favs = DATA.favorites.map((f) => favHit(s, f)).filter(Boolean);
  if (favs.length) html += `<div class="card fav"><div class="vendor">⭐ 常點單品</div><div class="items">${favs.map(({ v, it }) => itemRow(v, it, true)).join('')}</div></div>`;
  html += sortVendors(s.vendors).map((v) => `<div class="card ${vendorOut(v) ? 'out' : ''}" data-v="${v.id}"><div class="vendor"><span>${v.name} <small>${vendorOut(v) ? '售完' : (v.priceRange || '') + (v.quantity != null ? ' · 剩' + v.quantity : '')}</small></span><span>${v.items.length}項 ▾</span></div><div class="items">${sortItems(v).map((it) => itemRow(v, it)).join('') || '<div class="q">（無法讀取品項）</div>'}</div></div>`).join('');
  if (DATA.orders.length) html += `<div class="card"><div class="vendor">最近訂單</div>${DATA.orders.slice(0, 5).map((o) => `<div class="q">${fmt(o.at)} ${o.date || ''} ${(o.items || []).map((l) => `${l.itemName}×${l.qty}`).join('、') || o.itemName} ${o.submitted ? '✅' : '⏳'}</div>`).join('')}</div>`;
  const wasOpen = new Set([...$('#main').querySelectorAll('.card.open[data-v]')].map((c) => c.dataset.v));
  $('#main').innerHTML = html;
  $('#main').querySelectorAll('.card[data-v]').forEach((c) => wasOpen.has(c.dataset.v) && c.classList.add('open'));
  $('#main').querySelectorAll('.card .vendor').forEach((h) => (h.onclick = () => {
    const card = h.parentElement; card.classList.toggle('open');
    // Expanding a vendor re-fetches that one product page so 剩N is live (skip if refreshed < 60 s ago).
    const vid = card.dataset.v, v = vid && s.vendors.find((x) => x.id === vid);
    if (card.classList.contains('open') && v && !(v.refreshedAt && Date.now() - Date.parse(v.refreshedAt) < 60000)) {
      const tag = card.querySelector('.vendor small'); if (tag) tag.textContent += ' · 更新中…';
      chrome.runtime.sendMessage({ type: 'refreshVendor', slotKey: s.key, vendorId: vid }, () => {});   // storage change → load() re-renders
    }
  }));
  const rs = $('#refresh-slot'); if (rs) rs.onclick = () => { rs.textContent = '更新中…'; rs.disabled = true; chrome.runtime.sendMessage({ type: 'refreshSlot', slotKey: s.key }, () => {}); };
  const dec = (s) => JSON.parse(decodeURIComponent(s));
  $('#main').querySelectorAll('[data-fav]').forEach((b) => (b.onclick = async (e) => { e.stopPropagation(); const f = dec(b.dataset.fav); const i = DATA.favorites.findIndex((x) => same(x, f)); if (i >= 0) DATA.favorites.splice(i, 1); else DATA.favorites.unshift(f); await S.set({ favorites: DATA.favorites }); render(); }));
  $('#main').querySelectorAll('[data-add]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); addToBasket(dec(b.dataset.add), 1); }));
  $('#main').querySelectorAll('[data-dec]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); addToBasket(dec(b.dataset.dec), -1); }));
  $('#main').querySelectorAll('[data-combo]').forEach((b) => (b.onclick = async () => { const c = DATA.combos[+b.dataset.combo]; for (const l of c.items) { const h = favHit(s, l); if (h) await addToBasket(lineOf(h.v, h.it), l.qty, true); } await saveBasket(); }));
  $('#main').querySelectorAll('[data-combo-del]').forEach((b) => (b.onclick = async () => { DATA.combos.splice(+b.dataset.comboDel, 1); await S.set({ combos: DATA.combos }); render(); }));
  const c = $('#cancel'); if (c) c.onclick = async () => { await S.remove('pending'); load(); };
}
async function addToBasket(line, delta, defer = false) {
  const i = DATA.basket.findIndex((b) => same(b, line));
  if (i >= 0) { DATA.basket[i].qty += delta; if (DATA.basket[i].qty <= 0) DATA.basket.splice(i, 1); }
  else if (delta > 0) DATA.basket.push({ ...line, qty: delta, slotKey: current.key, date: current.date });
  if (!defer) await saveBasket();
}
async function saveBasket() { await S.set({ basket: DATA.basket }); render(); renderBasket(); }
function renderBasket() {
  const b = DATA.basket, bar = $('#basket');
  if (!b.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'block';
  const total = b.reduce((a, l) => a + (l.price || 0) * l.qty, 0), days = [...new Set(b.map((l) => l.date))];
  $('#basket-list').innerHTML = b.map((l, i) => `<div class="item"><span class="n">${l.vendorName} · ${l.itemName}</span><span class="p">×${l.qty}</span><button class="sm" data-rm="${i}">✕</button></div>`).join('');
  $('#basket-sum').textContent = `${b.length} 樣，約 NT$${total}${days.length > 1 ? '（⚠ 跨 ' + days.join(' / ') + '）' : ' · ' + (days[0] || '')}`;
  $('#basket-list').querySelectorAll('[data-rm]').forEach((x) => (x.onclick = async () => { DATA.basket.splice(+x.dataset.rm, 1); await saveBasket(); }));
  $('#go').disabled = !!DATA.pending;
}
$('#go').onclick = () => {
  $('#go').disabled = true; $('#go').textContent = '檢查庫存…';
  chrome.runtime.sendMessage({ type: 'order', items: DATA.basket, slotKey: DATA.basket[0].slotKey, date: DATA.basket[0].date }, (r) => {
    if (r && r.error) { $('#go').disabled = false; $('#go').textContent = '一次結帳'; $('#basket-sum').textContent = '⚠ ' + r.error; chrome.runtime.sendMessage({ type: 'refreshSlot', slotKey: current.key }, () => {}); return; }
    window.close();
  });
};
$('#clear').onclick = async () => { DATA.basket = []; await saveBasket(); };
$('#save-combo').onclick = async () => { const name = prompt('組合名稱', '平常午餐'); if (!name) return; DATA.combos.unshift({ name, items: DATA.basket.map(({ vendorId, vendorName, itemName, qty }) => ({ vendorId, vendorName, itemName, qty })) }); await S.set({ combos: DATA.combos }); render(); };
$('#refresh').onclick = () => { $('#meta').textContent = '抓取中…'; chrome.runtime.sendMessage({ type: 'scrape' }, () => load()); };
$('#opts').onclick = () => chrome.runtime.openOptionsPage();
chrome.storage.onChanged.addListener((c) => { if (c.menu || c.pending || c.orders) load(); });
setInterval(load, 60000);   // statuses move with the clock: a slot that just closed drops out, the next one is selected
load();
