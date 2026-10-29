import { cfg, categorySlug, DAY_SLUGS, DAY_ZH, readJson, writeJson, TZ } from './config.js';
import { fetchHtml, newPage } from './browser.js';

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Parse one category page: title "(午)(工業東一區) 10/30(五)" + the vendor cards. */
export function parseCategory(html) {
  const title = decode((html.match(/<title>([^<]*)<\/title>/) || [])[1] || '').trim();
  const dm = title.match(/(\d{1,2})\/(\d{1,2})\(([一二三四五六日])\)/);
  const vendors = [];
  const re = /<a class="Product-item[^"]*"\s+href="([^"]+)"\s+product-id="([a-f0-9]{24})"[\s\S]*?<div class="Label-title[^"]*">([^<]*)<\/div>\s*(?:<div class="[^"]*Label-price[^"]*">([^<]*)<\/div>)?/g;
  let m;
  while ((m = re.exec(html))) {
    const card = m[0];
    vendors.push({
      id: m[2],
      url: m[1],
      name: decode(m[3]).trim(),
      priceRange: (m[4] || '').trim(),
      soldOut: /sold-out|售完|sold_out/i.test(card),
    });
  }
  return { title, month: dm ? +dm[1] : null, day: dm ? +dm[2] : null, weekdayZh: dm ? dm[3] : null, vendors };
}

/** Parse a product page: the app.value('product', {...}) JSON. */
export function parseProduct(html) {
  const anchor = html.indexOf("app.value('product', ");
  if (anchor < 0) throw new Error('product JSON not found');
  const start = html.indexOf('{', anchor);
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const p = JSON.parse(html.slice(start, end));
  return {
    id: p._id,
    name: p.title_translations?.['zh-hant'] || p.title_translations?.en || '',
    status: p.status,
    soldOut: !!p.sold_out,
    quantity: p.quantity,
    availableFrom: p.available_start_time || null,
    availableUntil: p.available_end_time || null,
    maxOrderQty: p.max_order_quantity || 0,
    items: (p.variations || []).map((v) => ({
      id: v.key || v._id,
      sku: v.sku,
      name: (v.fields_translations?.['zh-hant'] || v.fields_translations?.en || []).join(' / '),
      price: v.price?.dollars ?? null,
      priceLabel: v.price?.label || '',
      qty: v.quantity ?? null,
    })),
  };
}

/** Resolve the calendar date (YYYY-MM-DD, Taipei) that a category's "10/30(五)" label refers to. */
function resolveDate(month, day) {
  if (!month || !day) return null;
  const now = new Date();
  const y = +new Intl.DateTimeFormat('en', { timeZone: TZ, year: 'numeric' }).format(now);
  const nowM = +new Intl.DateTimeFormat('en', { timeZone: TZ, month: 'numeric' }).format(now);
  let year = y;
  if (month === 1 && nowM === 12) year = y + 1;
  if (month === 12 && nowM === 1) year = y - 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Scrape every slot (meal × weekday) for the configured area.
 * Result: { scrapedAt, slots: { "lunch:fri": { meal, day, date, label, category, window:{from,until}, vendors:[{..., items:[...]}] } } }
 */
export async function scrapeAll({ onProgress = () => {}, meals = Object.keys(cfg.meals) } = {}) {
  const page = await newPage();
  const out = { scrapedAt: new Date().toISOString(), area: cfg.area, slots: {} };
  try {
    for (const mealKey of meals) {
      const meal = cfg.meals[mealKey];
      for (const day of meal.days) {
        const slug = categorySlug(mealKey, day);
        const url = `${cfg.base}/categories/${slug}`;
        onProgress(`category ${slug}`);
        let cat;
        try { cat = parseCategory(await fetchHtml(url, { page })); }
        catch (e) { onProgress(`  skip ${slug}: ${e.message}`); continue; }
        const slot = {
          key: `${mealKey}:${day}`, meal: mealKey, mealLabel: meal.label, day, dayZh: DAY_ZH[day],
          date: resolveDate(cat.month, cat.day), label: cat.title, category: slug, url,
          window: { from: null, until: null }, vendors: [],
        };
        for (const v of cat.vendors) {
          onProgress(`  vendor ${v.name}`);
          try {
            const p = parseProduct(await fetchHtml(v.url, { page }));
            slot.vendors.push({ ...v, ...p, url: v.url });
            if (p.availableFrom && (!slot.window.from || p.availableFrom < slot.window.from)) slot.window.from = p.availableFrom;
            if (p.availableUntil && (!slot.window.until || p.availableUntil > slot.window.until)) slot.window.until = p.availableUntil;
          } catch (e) { onProgress(`  skip vendor ${v.name}: ${e.message}`); slot.vendors.push({ ...v, items: [], error: e.message }); }
        }
        out.slots[slot.key] = slot;
      }
    }
  } finally { await page.close().catch(() => {}); }
  writeJson('menu.json', out);
  return out;
}

export function loadMenu() { return readJson('menu.json', null); }

/** Which slots can be ordered right now, and which open next. */
export function slotStatus(slot, now = Date.now()) {
  const from = slot.window.from ? Date.parse(slot.window.from) : null;
  const until = slot.window.until ? Date.parse(slot.window.until) : null;
  if (from && until) {
    if (now < from) return 'upcoming';
    if (now <= until) return 'open';
    return 'closed';
  }
  return 'unknown';
}
