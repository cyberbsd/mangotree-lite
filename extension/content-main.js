// Runs in the page's own JS world so it can talk to SHOPLINE's AngularJS scope.
// Bridge: window event "mtl:cmd" {id, cmd, args} → "mtl:res" {id, ok, result|error}.
(() => {
  const $ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const label = (x) => (typeof x === 'string' ? x : (x && (x['zh-hant'] || x.en || Object.values(x)[0])) || '').trim();
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function scopeOf(sel) { const el = $(sel); return el && window.angular ? window.angular.element(el).scope() : null; }
  async function waitFor(fn, ms = 30000, step = 250) { const t = Date.now(); while (Date.now() - t < ms) { try { const v = fn(); if (v) return v; } catch {} await sleep(step); } throw new Error('timeout: ' + fn.toString().slice(0, 80)); }

  /** Select variation by visible name and add `qty` to the cart, through the controller's own functions. */
  async function addToCart({ itemName, qty = 1 }) {
    await waitFor(() => window.angular && $('.variation-detail, #btn-main-checkout'));
    const sc = await waitFor(() => { const s = scopeOf('.variation-detail') || scopeOf('#btn-main-checkout'); return s && s.product ? s : null; });
    const target = norm(itemName);
    const log = [];

    // New-style variations (field_titles + digest_variations) — this store uses one field "品項".
    if (sc.product.field_titles && sc.product.field_titles.length) {
      await waitFor(() => sc.product.digest_variations && sc.product.digest_variations[0]);
      for (let i = 0; i < sc.product.field_titles.length; i++) {
        const opts = sc.product.digest_variations[i] || [];
        const hit = opts.find((o) => norm(label(o)) === target) || opts.find((o) => target.startsWith(norm(label(o))) || norm(label(o)).startsWith(target));
        if (!hit) throw new Error(`variation "${target}" not in [${opts.map(label).join(' | ')}]`);
        sc.$apply(() => { sc.variationName[i] = hit; sc.onVariationChanged(i); });
        log.push(`field ${i} ← ${label(hit)}`);
        await sleep(300);
      }
    } else {
      const v = (sc.product.variations || []).find((x) => norm(label(x.fields_translations?.['zh-hant']?.join(' / ') || x.name)) === target);
      if (!v) throw new Error(`variation "${target}" not found`);
      sc.$apply(() => { sc.variationSelected = v; sc.onVariationChanged && sc.onVariationChanged(); });
      log.push(`variationSelected ← ${target}`);
    }

    await waitFor(() => sc.state && sc.state.checkoutReady && sc.hasStock, 15000).catch(() => { throw new Error(`not orderable (checkoutReady=${sc.state?.checkoutReady}, hasStock=${sc.hasStock})`); });
    sc.$apply(() => { sc.addItemQuantity = qty; });
    const before = norm($('.sl-cart-count, .Cart-count')?.textContent);
    sc.$apply(() => sc.addItemToCart());
    log.push('addItemToCart()');
    // Wait for the cart badge to change or a cart panel/toast to show.
    await waitFor(() => norm($('.sl-cart-count, .Cart-count')?.textContent) !== before || $('.cart-panel.is-open, .CartPanel.is-open, .quick-cart-modal, .sl-cart-notification'), 15000).catch(() => log.push('no visible cart change (may still be fine)'));
    return { selected: sc.variationSelected && label(sc.variationSelected.fields_translations?.['zh-hant']?.join(' / ') || sc.variationSelected.name), cartBefore: before, cartAfter: norm($('.sl-cart-count, .Cart-count')?.textContent), log };
  }

  /** Checkout page helpers. */
  async function checkout({ note = '', autoSubmit = false }) {
    await waitFor(() => $('textarea, #checkout-container, .checkout-container, form[name="checkoutForm"], #btn-checkout, .btn-checkout'), 30000);
    await sleep(1500);
    const log = [];
    const ta = [...document.querySelectorAll('textarea')].find((t) => t.offsetParent !== null);
    if (ta && !ta.value) {
      ta.value = note; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new Event('change', { bubbles: true }));
      log.push('note filled');
    }
    for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
      const txt = norm(cb.closest('label')?.textContent || cb.parentElement?.textContent);
      if (/同意|agree|條款|terms/i.test(txt) && !cb.checked) { cb.click(); log.push('agreement ticked'); }
    }
    let submitted = false;
    if (autoSubmit) {
      const btn = [...document.querySelectorAll('button, input[type="submit"], a.btn')].find((b) => b.offsetParent !== null && /提交訂單|送出訂單|確認訂單|下單|place order|submit order/i.test(norm(b.textContent || b.value)));
      if (btn) { btn.click(); log.push('clicked: ' + norm(btn.textContent || btn.value)); submitted = true; }
      else log.push('submit button not found; left for you');
    }
    return { submitted, log, url: location.href };
  }

  // Optional XHR/fetch logger (settings.recordNet) → "mtl:net" events, saved by content.js.
  function installNetLogger() {
    const emit = (d) => window.dispatchEvent(new CustomEvent('mtl:net', { detail: d }));
    const of = window.fetch; window.fetch = async function (i, o) { const r = await of.apply(this, arguments); try { const c = r.clone(); c.text().then((b) => emit({ t: Date.now(), kind: 'fetch', method: (o && o.method) || 'GET', url: String(i.url || i), post: o && typeof o.body === 'string' ? o.body.slice(0, 2000) : null, status: r.status, body: b.slice(0, 2000) })); } catch {} return r; };
    const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__mtl = { method: m, url: String(u) }; return oo.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (b) { this.addEventListener('loadend', () => emit({ t: Date.now(), kind: 'xhr', ...this.__mtl, post: typeof b === 'string' ? b.slice(0, 2000) : null, status: this.status, body: String(this.responseText || '').slice(0, 2000) })); return os.apply(this, arguments); };
  }

  window.addEventListener('mtl:cmd', async (ev) => {
    const { id, cmd, args } = ev.detail || {};
    const res = { id };
    try {
      if (cmd === 'add') res.result = await addToCart(args || {});
      else if (cmd === 'checkout') res.result = await checkout(args || {});
      else if (cmd === 'net') { installNetLogger(); res.result = true; }
      else if (cmd === 'user') res.result = !!(window.mainConfig && window.mainConfig.currentUser);
      else throw new Error('unknown cmd ' + cmd);
      res.ok = true;
    } catch (e) { res.ok = false; res.error = e.message; }
    window.dispatchEvent(new CustomEvent('mtl:res', { detail: res }));
  });
})();
