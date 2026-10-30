importScripts('config.js', 'parse.js');

const S = chrome.storage.local;
const get = async (k, d) => (await S.get(k))[k] ?? d;
const settings = async () => ({ ...MT.defaults, ...(await get('settings', {})) });

// ---------- scraping ----------
async function fetchHtml(url) {
  const r = await fetch(url, { credentials: 'include', cache: 'no-store', headers: { accept: 'text/html,application/xhtml+xml', 'accept-language': 'zh-TW,zh;q=0.9' } });
  const t = await r.text();
  if (/The site is now busy/.test(t)) throw new Error('shield page');
  return t;
}
function resolveDate(month, day) {
  if (!month || !day) return null;
  const now = new Date(), y = now.getFullYear(), nm = now.getMonth() + 1;
  let year = y; if (month === 1 && nm === 12) year++; if (month === 12 && nm === 1) year--;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
async function scrape() {
  const st = await settings();
  if (st.menuUrl) {
    const menu = await (await fetch(st.menuUrl + (st.menuUrl.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' })).json();
    await S.set({ menu }); return menu;
  }
  const menu = { scrapedAt: new Date().toISOString(), area: MT.area, slots: {} };
  for (const mealKey of st.scrapeMeals) {
    const meal = MT.meals[mealKey]; if (!meal) continue;
    for (const day of meal.days) {
      const slug = `${MT.area.slug}-${day}-${meal.suffix}`, url = `${MT.base}/categories/${slug}`;
      let cat; try { cat = MTParse.parseCategory(await fetchHtml(url)); } catch (e) { console.warn('skip', slug, e.message); continue; }
      const slot = { key: `${mealKey}:${day}`, meal: mealKey, mealLabel: meal.label, day, dayZh: MT.dayZh[day], date: resolveDate(cat.month, cat.day), label: cat.title, category: slug, url, window: { from: null, until: null }, vendors: [] };
      for (const v of cat.vendors) {
        try {
          const p = MTParse.parseProduct(await fetchHtml(v.url));
          slot.vendors.push({ ...v, ...p, url: v.url });
          if (p.availableFrom && (!slot.window.from || p.availableFrom < slot.window.from)) slot.window.from = p.availableFrom;
          if (p.availableUntil && (!slot.window.until || p.availableUntil > slot.window.until)) slot.window.until = p.availableUntil;
        } catch (e) { slot.vendors.push({ ...v, items: [], error: e.message }); }
      }
      menu.slots[slot.key] = slot;
    }
  }
  await S.set({ menu });
  return menu;
}

/** Re-fetch one vendor's product page and update its items/stock in the stored menu. */
async function refreshVendor(slotKey, vendorId) {
  const menu = await get('menu'); const slot = menu?.slots?.[slotKey]; if (!slot) throw new Error('no slot');
  const i = slot.vendors.findIndex((v) => v.id === vendorId); if (i < 0) throw new Error('no vendor');
  const p = MTParse.parseProduct(await fetchHtml(slot.vendors[i].url));
  slot.vendors[i] = { ...slot.vendors[i], ...p, url: slot.vendors[i].url, refreshedAt: new Date().toISOString() };
  await S.set({ menu }); return slot.vendors[i];
}
/** Re-fetch a whole slot (category + every vendor). */
async function refreshSlot(slotKey) {
  const menu = await get('menu'); const slot = menu?.slots?.[slotKey]; if (!slot) throw new Error('no slot');
  const cat = MTParse.parseCategory(await fetchHtml(slot.url));
  const vendors = [];
  for (const v of cat.vendors) {
    try { const p = MTParse.parseProduct(await fetchHtml(v.url)); vendors.push({ ...v, ...p, url: v.url, refreshedAt: new Date().toISOString() }); }
    catch (e) { vendors.push({ ...v, items: [], error: e.message }); }
  }
  slot.vendors = vendors; slot.refreshedAt = new Date().toISOString();
  await S.set({ menu }); return slot;
}
/** Live stock check for basket lines: returns { soldOut:[names], low:[{name, left}] }. */
async function checkStock(items) {
  const byUrl = new Map();
  for (const l of items) { const u = l.vendorUrl.split('?')[0]; if (!byUrl.has(u)) byUrl.set(u, MTParse.parseProduct(await fetchHtml(u))); }
  const favKey = (s) => String(s || '').replace(/\s*\$?\s*\d+(\.\d+)?\s*$/, '').replace(/\s+/g, '').trim();
  const soldOut = [], low = [];
  for (const l of items) {
    const p = byUrl.get(l.vendorUrl.split('?')[0]);
    const it = p.items.find((i) => i.name === l.itemName) || p.items.find((i) => favKey(i.name) === favKey(l.itemName));
    if (!it || it.qty === 0 || p.soldOut) soldOut.push(l.itemName);
    else if (it.qty != null && it.qty < (l.qty || 1)) low.push({ name: l.itemName, left: it.qty });
  }
  return { soldOut, low };
}

// ---------- reminders ----------
const favKey = (s) => String(s || '').replace(/\s*\$?\s*\d+(\.\d+)?\s*$/, '').replace(/\s+/g, '').trim();
const favHit = (slot, f) => { for (const v of slot.vendors) { if (v.id !== f.vendorId && v.name !== f.vendorName) continue; const it = (v.items || []).find((i) => i.name === f.itemName) || (v.items || []).find((i) => favKey(i.name) === favKey(f.itemName)); if (it) return { v, it }; } return null; };
async function checkReminders() {
  const st = await settings(), menu = await get('menu'); if (!menu) return;
  const sent = await get('remindersSent', {}), orders = await get('orders', []), favs = await get('favorites', []);
  const now = Date.now(), MIN = 60000;
  for (const slot of Object.values(menu.slots)) {
    const here = favs.filter((f) => favHit(slot, f));
    const favHint = here.length ? `常點：${here.slice(0, 2).map((f) => f.itemName).join('、')}` : '';
    if (!st.remindMeals.includes(slot.meal) || !slot.window.from || !slot.window.until || !slot.date) continue;
    const from = Date.parse(slot.window.from), until = Date.parse(slot.window.until), status = MTParse.slotStatus(slot, now);
    const ordered = orders.some((o) => o.slotKey === slot.key && o.date === slot.date);
    const key = `${slot.key}:${slot.date}`, md = slot.date.slice(5).replace('-', '/');
    const hhmm = new Date(until).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (st.remindOnOpen && status === 'open' && !sent[key + ':open'] && now - from < 6 * 60 * MIN && !ordered) {
      notify(key + ':open', `🍱 ${slot.mealLabel} ${md}(${slot.dayZh}) 開放訂餐`, `${MT.area.name}，截止 ${hhmm}。${favHint}`);
      sent[key + ':open'] = now;
    }
    if (status === 'open' && now >= until - st.minutesBeforeClose * MIN && !sent[key + ':close'] && !ordered) {
      notify(key + ':close', `⏰ ${slot.mealLabel} ${md}(${slot.dayZh}) 還沒訂！`, `${hhmm} 截止。${favHint}`);
      sent[key + ':close'] = now;
    }
  }
  // Weekly menu change (store publishes next week on Saturday).
  const dates = Object.values(menu.slots).map((s) => s.date).filter(Boolean).sort(), weekKey = dates[dates.length - 1] || '';
  const lastWeekKey = await get('lastWeekKey', '');
  if (weekKey && weekKey > lastWeekKey && Object.values(menu.slots).some((s) => s.vendors.length)) {
    const lines = favs.map((f) => { const days = Object.values(menu.slots).filter((s) => st.remindMeals.includes(s.meal) && favHit(s, f)).map((s) => `${s.date.slice(5).replace('-', '/')}(${s.dayZh})`); return days.length ? `${f.itemName}：${days.join(' ')}` : null; }).filter(Boolean);
    if (lastWeekKey) notify('week:' + weekKey, `📅 ${MT.area.name} 新菜單（到 ${weekKey.slice(5).replace('-', '/')}）`, lines.length ? lines.join('\n') : '常點的品項這週沒出現，打開看看有什麼新的。');
    await S.set({ lastWeekKey: weekKey });
  }
  for (const k of Object.keys(sent)) if (now - sent[k] > 14 * 24 * 60 * MIN) delete sent[k];
  await S.set({ remindersSent: sent });
}
function notify(id, title, message) {
  chrome.notifications.create(id, { type: 'basic', iconUrl: 'icons/128.png', title, message, priority: 2, requireInteraction: true });
}
chrome.notifications.onClicked.addListener((id) => { chrome.action.openPopup?.().catch(() => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') })); chrome.notifications.clear(id); });

// ---------- one-click order ----------
// popup → bg: {type:'order', items:[{vendorUrl, vendorName, itemName, qty}], slotKey, date}
// bg stores the pending basket and opens the first vendor page; content.js adds every line for that
// vendor, then moves on to the next vendor, then /checkout.
async function startOrder(o) {
  const items = (o.items || []).map((l) => ({ ...l, done: false }));
  if (!items.length) throw new Error('empty basket');
  const stock = await checkStock(items);                       // live check right before ordering
  if (stock.soldOut.length) throw new Error('已售完：' + stock.soldOut.join('、'));
  if (stock.low.length) items.forEach((l) => { const w = stock.low.find((x) => x.name === l.itemName); if (w) l.qty = w.left; });
  const pending = { id: `${Date.now()}`, items, slotKey: o.slotKey, date: o.date, stage: 'add', done: 0, startedAt: Date.now(), log: [] };
  await S.set({ pending });
  const url = items[0].vendorUrl + (items[0].vendorUrl.includes('?') ? '&' : '?') + 'mtl=' + pending.id;
  const tab = await chrome.tabs.create({ url, active: true });
  await S.set({ pending: { ...pending, tabId: tab.id } });
  return pending.id;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === 'scrape') reply(await scrape());
    else if (msg.type === 'refreshVendor') reply(await refreshVendor(msg.slotKey, msg.vendorId));
    else if (msg.type === 'refreshSlot') reply(await refreshSlot(msg.slotKey));
    else if (msg.type === 'checkStock') reply(await checkStock(msg.items));
    else if (msg.type === 'order') reply(await startOrder(msg));
    else if (msg.type === 'remind') { await checkReminders(); reply(true); }
    else if (msg.type === 'ordered') {           // from content.js when checkout is done
      const orders = await get('orders', []); orders.push({ at: new Date().toISOString(), ...msg.order }); await S.set({ orders: orders.slice(-100) });
      notify('ordered-' + Date.now(), '✅ 已下單', (msg.order.items || []).map((l) => `${l.itemName}×${l.qty}`).join('、')); reply(true);
    }
    else reply(null);
  })().catch((e) => reply({ error: e.message }));
  return true;
});

// ---------- schedule ----------
async function setupAlarms() {
  const st = await settings();
  chrome.alarms.create('scrape', { periodInMinutes: Math.max(10, st.scrapeEveryMin), delayInMinutes: 0.1 });
  chrome.alarms.create('remind', { periodInMinutes: 1, delayInMinutes: 1 });
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'scrape') scrape().then(checkReminders).catch((e) => console.warn(e)); if (a.name === 'remind') checkReminders().catch(() => {}); });
chrome.runtime.onInstalled.addListener(setupAlarms);
chrome.runtime.onStartup.addListener(setupAlarms);
chrome.storage.onChanged.addListener((c) => { if (c.settings) setupAlarms(); });
