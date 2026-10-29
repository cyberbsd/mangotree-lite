import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { cfg, env, PROFILE_DIR, DATA_DIR } from './config.js';

let ctx = null;

/** One persistent Chromium profile (cookies survive restarts, so login happens rarely). */
export async function getContext({ headless = env.headless } = {}) {
  if (ctx) return ctx;
  ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    ...(process.env.MT_CHROME_PATH ? { executablePath: process.env.MT_CHROME_PATH } : {}),
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    viewport: { width: 1100, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  ctx.setDefaultTimeout(30000);
  return ctx;
}

export async function closeContext() {
  if (ctx) { await ctx.close().catch(() => {}); ctx = null; }
}

export async function newPage(opts) {
  const c = await getContext(opts);
  const page = await c.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  return page;
}

/** Light-weight GET of a storefront page's server-rendered HTML (no need to wait for Angular). */
export async function fetchHtml(url, { page } = {}) {
  const own = !page;
  if (own) page = await newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const html = await page.content();
    if (/The site is now busy/.test(html)) throw new Error('mangotree.tw returned the "site busy" shield page');
    return html;
  } finally {
    if (own) await page.close().catch(() => {});
  }
}

/** Optional request log: every XHR/fetch the storefront makes, to data/netlog-<ts>.jsonl. */
export function recordNetwork(page, tag = 'net') {
  const file = path.join(DATA_DIR, `netlog-${tag}-${Date.now()}.jsonl`);
  page.on('requestfinished', async (req) => {
    if (!['xhr', 'fetch'].includes(req.resourceType())) return;
    let status = null, body = null;
    try { const res = await req.response(); status = res?.status(); body = (await res?.text())?.slice(0, 2000); } catch {}
    fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), method: req.method(), url: req.url(), post: req.postData()?.slice(0, 2000) || null, status, body }) + '\n');
  });
  return file;
}

export async function isLoggedIn(page) {
  // SHOPLINE exposes the current user in window.mainConfig on every page.
  const user = await page.evaluate(() => (window.mainConfig && window.mainConfig.currentUser) || null).catch(() => null);
  return !!user;
}

/**
 * Make sure the persistent profile is logged in. Uses MT_EMAIL/MT_PASSWORD from .env.
 * reCAPTCHA Enterprise is enabled on this store, so if the automated submit is blocked
 * the window stays open and you finish the login by hand once; cookies then persist.
 */
export async function ensureLoggedIn(page) {
  await page.goto(`${cfg.base}/users/sign_in`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  if (await isLoggedIn(page)) return true;
  if (!page.url().includes('/users/sign_in')) return isLoggedIn(page); // already redirected away = logged in
  if (!env.email || !env.password) throw new Error('Not logged in and MT_EMAIL / MT_PASSWORD are not set in .env');

  const emailBox = page.locator('[data-e2e-id="login-email_input"]');
  await emailBox.waitFor({ timeout: 30000 });
  await emailBox.fill(env.email);
  await page.locator('[data-e2e-id="login-password_input"]').fill(env.password);
  await page.locator('[data-e2e-id="login-submit_button"]').click();
  // Wait for redirect away from the sign-in page, or give a human up to 3 minutes (captcha / OTP).
  const deadline = Date.now() + (env.headless ? 30000 : 180000);
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    if (!page.url().includes('/users/sign_in')) break;
  }
  await page.goto(`${cfg.base}/`, { waitUntil: 'domcontentloaded' });
  const ok = await isLoggedIn(page);
  if (!ok) throw new Error('Login did not complete. Run `npm run login` with MT_HEADLESS=false and finish it in the window.');
  return ok;
}
