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

// ---------- reminders ----------
async function checkReminders() {
  const st = await settings(), menu = await get('menu'); if (!menu) return;
  const sent = await get('remindersSent', {}), orders = await get('orders', []), favs = await get('favorites', []);
  const now = Date.now(), MIN = 60000;
  const favHint = favs.length ? `常點：${favs.slice(0, 2).map((f) => f.itemName).join('、')}` : '';
  for (const slot of Object.values(menu.slots)) {
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
  for (const k of Object.keys(sent)) if (now - sent[k] > 14 * 24 * 60 * MIN) delete sent[k];
  await S.set({ remindersSent: sent });
}
function notify(id, title, message) {
  chrome.notifications.create(id, { type: 'basic', iconUrl: 'icons/128.png', title, message, priority: 2, requireInteraction: true });
}
chrome.notifications.onClicked.addListener((id) => { chrome.action.openPopup?.().catch(() => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') })); chrome.notifications.clear(id); });

// ---------- one-click order ----------
// popup → bg: {type:'order', vendorUrl, itemName, itemId, qty, slotKey, date}
// bg stores a pending order and opens the product page; content.js picks it up from storage.
async function startOrder(o) {
  const pending = { ...o, id: `${Date.now()}`, stage: 'add', startedAt: Date.now(), log: [] };
  await S.set({ pending });
  const url = o.vendorUrl + (o.vendorUrl.includes('?') ? '&' : '?') + 'mtl=' + pending.id;
  const tab = await chrome.tabs.create({ url, active: true });
  await S.set({ pending: { ...pending, tabId: tab.id } });
  return pending.id;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === 'scrape') reply(await scrape());
    else if (msg.type === 'order') reply(await startOrder(msg));
    else if (msg.type === 'remind') { await checkReminders(); reply(true); }
    else if (msg.type === 'ordered') {           // from content.js when checkout is done
      const orders = await get('orders', []); orders.push({ at: new Date().toISOString(), ...msg.order }); await S.set({ orders: orders.slice(-100) });
      notify('ordered-' + Date.now(), '✅ 已下單', `${msg.order.itemName} ×${msg.order.qty || 1}`); reply(true);
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
