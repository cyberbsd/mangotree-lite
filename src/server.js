import express from 'express';
import path from 'node:path';
import { cfg, env, ROOT, readJson, writeJson } from './config.js';
import { loadMenu, scrapeAll, slotStatus } from './menu.js';
import { placeOrder } from './order.js';
import { startScheduler, checkReminders } from './remind.js';

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/menu', (req, res) => {
  const menu = loadMenu();
  if (!menu) return res.json({ ready: false });
  const now = Date.now();
  const slots = Object.values(menu.slots).map((s) => ({ ...s, status: slotStatus(s, now) }))
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.meal.localeCompare(b.meal));
  res.json({ ready: true, scrapedAt: menu.scrapedAt, area: cfg.area, slots, favorites: readJson('favorites.json', []), orders: readJson('orders.json', []).slice(-20).reverse(), config: cfg.reminders });
});

app.post('/api/scrape', async (req, res) => {
  try { await scrapeAll({ meals: req.body?.meals }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/favorites', (req, res) => {
  const fav = readJson('favorites.json', []);
  const f = req.body; // {vendorId, vendorName, itemId, itemName, price}
  const i = fav.findIndex((x) => x.vendorId === f.vendorId && x.itemName === f.itemName);
  if (i >= 0) fav.splice(i, 1); else fav.unshift(f);
  writeJson('favorites.json', fav);
  res.json(fav);
});

/** Order via Playwright (stored credentials). Opens a visible browser on this machine. */
app.post('/api/order', async (req, res) => {
  const { items, vendorUrl, itemName, qty = 1, autoSubmit = false, record = false, slotKey, date } = req.body || {};
  if (!(items && items.length) && !(vendorUrl && itemName)) return res.status(400).json({ ok: false, error: 'items[] or vendorUrl+itemName required' });
  res.json(await placeOrder({ items, vendorUrl, itemName, qty, autoSubmit, record, slotKey, date }));
});

/** Mark an order you placed by hand / via Claude in Chrome, so reminders go quiet. */
app.post('/api/orders/manual', (req, res) => {
  const orders = readJson('orders.json', []);
  orders.push({ at: new Date().toISOString(), submitted: true, manual: true, ...req.body });
  writeJson('orders.json', orders);
  res.json({ ok: true });
});

app.post('/api/remind/test', async (req, res) => res.json({ fired: await checkReminders({ now: Date.now() }) }));

app.listen(env.port, () => {
  console.log(`mangotree-lite  →  http://localhost:${env.port}   (${cfg.area.name})`);
  startScheduler();
});
