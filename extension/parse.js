// Shared parsers for mangotree.tw (SHOPLINE) server-rendered HTML. Plain script: usable from the
// service worker (importScripts) and from Node tests (globalThis.MTParse).
(function (g) {
  const decode = (s) => String(s || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  /** Category page → { title, month, day, weekdayZh, vendors:[{id,url,name,priceRange,soldOut}] } */
  function parseCategory(html) {
    const title = decode((html.match(/<title>([^<]*)<\/title>/) || [])[1] || '').trim();
    const dm = title.match(/(\d{1,2})\/(\d{1,2})\(([一二三四五六日])\)/);
    const vendors = [];
    const re = /<a class="Product-item[^"]*"\s+href="([^"]+)"\s+product-id="([a-f0-9]{24})"[\s\S]*?<div class="Label-title[^"]*">([^<]*)<\/div>\s*(?:<div class="[^"]*Label-price[^"]*">([^<]*)<\/div>)?/g;
    let m;
    while ((m = re.exec(html))) vendors.push({ id: m[2], url: m[1], name: decode(m[3]).trim(), priceRange: (m[4] || '').trim(), soldOut: /sold-out|售完|sold_out/i.test(m[0]) });
    return { title, month: dm ? +dm[1] : null, day: dm ? +dm[2] : null, weekdayZh: dm ? dm[3] : null, vendors };
  }

  /** Product page → vendor with items (variations), stock and ordering window. */
  function parseProduct(html) {
    const anchor = html.indexOf("app.value('product', ");
    if (anchor < 0) throw new Error('product JSON not found');
    const start = html.indexOf('{', anchor);
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    const p = JSON.parse(html.slice(start, end));
    return {
      id: p._id,
      name: p.title_translations?.['zh-hant'] || p.title_translations?.en || '',
      status: p.status, soldOut: !!p.sold_out, quantity: p.quantity,
      availableFrom: p.available_start_time || null, availableUntil: p.available_end_time || null,
      items: (p.variations || []).map((v) => ({
        id: v.key || v._id, sku: v.sku,
        name: (v.fields_translations?.['zh-hant'] || v.fields_translations?.en || []).join(' / '),
        price: v.price?.dollars ?? null, priceLabel: v.price?.label || '', qty: v.quantity ?? null,
      })),
    };
  }

  function slotStatus(slot, now = Date.now()) {
    const f = slot.window?.from ? Date.parse(slot.window.from) : null, u = slot.window?.until ? Date.parse(slot.window.until) : null;
    if (!f || !u) return 'unknown';
    return now < f ? 'upcoming' : now <= u ? 'open' : 'closed';
  }

  g.MTParse = { parseCategory, parseProduct, slotStatus };
})(typeof globalThis !== 'undefined' ? globalThis : self);
