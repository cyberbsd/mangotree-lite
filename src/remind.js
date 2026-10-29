import cron from 'node-cron';
import { cfg, readJson, writeJson, fmtTW, env } from './config.js';
import { loadMenu, scrapeAll, slotStatus } from './menu.js';
import { notify } from './notify.js';

const MIN = 60 * 1000;

function alreadyOrdered(slot) {
  if (!cfg.reminders.quietIfOrdered) return false;
  return readJson('orders.json', []).some((o) => o.slotKey === slot.key && o.date === slot.date);
}

/** Decide which reminders are due now (idempotent: each reminder fires once per slot/date). */
export async function checkReminders({ now = Date.now(), uiUrl = process.env.UI_URL || `http://localhost:${env.port}` } = {}) {
  const menu = loadMenu();
  if (!menu) return [];
  const sent = readJson('reminders-sent.json', {});
  const fired = [];
  for (const slot of Object.values(menu.slots)) {
    if (!cfg.reminders.meals.includes(slot.meal)) continue;
    if (!slot.window.from || !slot.window.until || !slot.date) continue;
    const from = Date.parse(slot.window.from), until = Date.parse(slot.window.until);
    const status = slotStatus(slot, now);
    const keyBase = `${slot.key}:${slot.date}`;
    const fav = readJson('favorites.json', []);
    const favHint = fav.length ? `常點：${fav.slice(0, 3).map((f) => `${f.vendorName} ${f.itemName}`).join('、')}` : '';

    if (cfg.reminders.onOpen && status === 'open' && !sent[keyBase + ':open'] && now - from < 6 * 60 * MIN && !alreadyOrdered(slot)) {
      await notify(`🍱 ${slot.mealLabel} ${slot.date.slice(5).replace('-', '/')}(${slot.dayZh}) 開放訂餐了`,
        `${cfg.area.name}，截止 ${fmtTW(until, false)}。${favHint}`, { url: `${uiUrl}/#${slot.key}` });
      sent[keyBase + ':open'] = now; fired.push(keyBase + ':open');
    }
    const closeAt = until - cfg.reminders.minutesBeforeClose * MIN;
    if (status === 'open' && now >= closeAt && !sent[keyBase + ':close'] && !alreadyOrdered(slot)) {
      await notify(`⏰ ${slot.mealLabel} ${slot.date.slice(5).replace('-', '/')}(${slot.dayZh}) 還沒訂！`,
        `${cfg.reminders.minutesBeforeClose} 分鐘後截止（${fmtTW(until, false)}）。${favHint}`, { url: `${uiUrl}/#${slot.key}` });
      sent[keyBase + ':close'] = now; fired.push(keyBase + ':close');
    }
  }
  // keep the sent-log small
  for (const k of Object.keys(sent)) if (now - sent[k] > 14 * 24 * 60 * MIN) delete sent[k];
  writeJson('reminders-sent.json', sent);
  return fired;
}

/** Background loop: re-scrape every N minutes, evaluate reminders every minute. */
export function startScheduler({ onLog = console.log } = {}) {
  const every = Math.max(10, cfg.scrapeEveryMinutes || 30);
  let scraping = false;
  const doScrape = async () => {
    if (scraping) return; scraping = true;
    try { onLog(`[scrape] start`); await scrapeAll({ onProgress: () => {} }); onLog(`[scrape] done`); }
    catch (e) { onLog(`[scrape] failed: ${e.message}`); }
    finally { scraping = false; }
  };
  cron.schedule(`*/${every} * * * *`, doScrape);
  cron.schedule('* * * * *', () => checkReminders().then((f) => f.length && onLog(`[remind] fired ${f.join(', ')}`)).catch((e) => onLog(`[remind] ${e.message}`)));
  if (!loadMenu()) doScrape();
  return { doScrape };
}
