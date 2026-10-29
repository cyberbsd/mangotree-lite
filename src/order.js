import { cfg, readJson, writeJson } from './config.js';
import { newPage, ensureLoggedIn, recordNetwork } from './browser.js';

/**
 * Put one item (vendor product + variation) into the mangotree.tw cart, then open checkout.
 * Driven through the real storefront UI so it keeps working without knowing SHOPLINE's private cart API.
 *
 * autoSubmit=false (default): stops on the checkout page with everything filled; you press the final button.
 * autoSubmit=true: also tries to press the place-order button.
 */
export async function placeOrder({ vendorUrl, itemName, qty = 1, autoSubmit = false, record = false, slotKey, date, note = '' }) {
  const page = await newPage({ headless: false });
  const log = record ? recordNetwork(page, 'order') : null;
  const steps = [];
  const step = (s) => { steps.push(s); console.log('[order]', s); };
  try {
    await ensureLoggedIn(page);
    step('logged in');

    await page.goto(vendorUrl, { waitUntil: 'domcontentloaded' });
    // Angular needs to finish rendering the product page.
    await page.waitForSelector('#btn-main-checkout, .js-btn-main-add-to-cart, .btn-add-back-in-stock', { timeout: 45000 });
    step('product page rendered');

    await selectVariation(page, itemName);
    step(`selected "${itemName}"`);

    if (qty > 1) {
      const qInput = page.locator('input[name="quantity"], .quantity-input input, input.js-quantity, input[ng-model*="quantity"]').first();
      if (await qInput.count()) { await qInput.fill(String(qty)); step(`qty ${qty}`); }
    }

    const addBtn = page.locator('#btn-main-checkout, .js-btn-main-add-to-cart, button:has-text("加入購物車")').first();
    await addBtn.waitFor({ state: 'visible', timeout: 15000 });
    await addBtn.click();
    await page.waitForTimeout(2500);
    step('added to cart');

    await page.goto(`${cfg.base}/checkout`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    if (page.url().includes('/users/sign_in')) throw new Error('checkout bounced to login');
    step('checkout page open');

    // Store-specific "注意事項" textarea (the store defines one custom text field). Fill if present and empty.
    const ta = page.locator('textarea').first();
    if (await ta.count() && !(await ta.inputValue())) await ta.fill(note || '').catch(() => {});

    // Agreement checkbox, if the theme shows one.
    for (const sel of ['#checkout-agreement', 'input[type="checkbox"][ng-model*="agree"]', '.checkout-agreement input[type="checkbox"]']) {
      const cb = page.locator(sel).first();
      if (await cb.count() && !(await cb.isChecked().catch(() => true))) { await cb.check().catch(() => {}); break; }
    }

    let submitted = false;
    if (autoSubmit) {
      for (const sel of ['#btn-checkout-submit', '.btn-checkout-submit', 'button[data-e2e-id="place-order_button"]', '#checkout-submit', 'button:has-text("提交訂單")', 'button:has-text("確認訂單")']) {
        const b = page.locator(sel).first();
        if (await b.count() && await b.isVisible().catch(() => false)) {
          await b.click();
          await page.waitForTimeout(6000);
          submitted = /\/orders\/|confirm|thank/i.test(page.url());
          step(submitted ? `submitted → ${page.url()}` : `clicked "${sel}" but no confirmation URL yet (${page.url()})`);
          break;
        }
      }
    }

    const orders = readJson('orders.json', []);
    orders.push({ at: new Date().toISOString(), slotKey, date, vendorUrl, itemName, qty, submitted, checkoutUrl: page.url() });
    writeJson('orders.json', orders);
    return { ok: true, submitted, steps, netlog: log, pageOpen: true };
  } catch (e) {
    step(`FAILED: ${e.message}`);
    return { ok: false, error: e.message, steps, netlog: log };
  }
  // The page is intentionally left open so you can see / finish the checkout.
}

/** Pick a variation by its visible label. Handles <select>, swatch buttons and radio-style lists. */
async function selectVariation(page, itemName) {
  const target = itemName.trim();
  // 1) <select> based themes
  for (const sel of await page.locator('select').all()) {
    const opts = await sel.locator('option').allTextContents();
    const hit = opts.find((o) => o.trim() === target) || opts.find((o) => o.includes(target));
    if (hit) { await sel.selectOption({ label: hit.trim() }); return; }
  }
  // 2) clickable option elements
  const candidates = page.locator('[class*="variation"] button, [class*="variation"] li, [class*="variation"] label, [class*="variation"] span, [class*="option"] button, [class*="option"] li, [class*="option"] label, [class*="swatch"] *');
  const n = await candidates.count();
  for (let i = 0; i < n; i++) {
    const el = candidates.nth(i);
    const t = (await el.innerText().catch(() => '')).trim();
    if (t === target || (t && target.startsWith(t) && t.length > 3)) { await el.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(600); return; }
  }
  // 3) plain text match anywhere in the product area
  const any = page.getByText(target, { exact: true }).first();
  if (await any.count()) { await any.click({ timeout: 3000 }); await page.waitForTimeout(600); return; }
  throw new Error(`variation "${target}" not found on page`);
}
