import { scrapeAll } from './menu.js';
import { newPage, ensureLoggedIn, closeContext } from './browser.js';
import { checkReminders } from './remind.js';
import { placeOrder } from './order.js';

const [cmd, ...rest] = process.argv.slice(2);
const arg = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };

try {
  if (cmd === 'scrape') {
    const meals = arg('--meals') ? arg('--meals').split(',') : undefined;
    const m = await scrapeAll({ onProgress: (s) => console.log(s), meals });
    for (const s of Object.values(m.slots)) console.log(`${s.key.padEnd(18)} ${s.date}  ${s.vendors.length} vendors  window ${s.window.from || '?'} → ${s.window.until || '?'}`);
  } else if (cmd === 'login') {
    const page = await newPage({ headless: false });
    await ensureLoggedIn(page);
    console.log('Logged in. Cookies saved in ./profile');
  } else if (cmd === 'remind') {
    console.log('fired:', await checkReminders());
  } else if (cmd === 'order') {
    // node src/cli.js order --url <vendor product url> --item "精緻燒肉飯 $85" [--qty 1] [--auto] [--record]
    const r = await placeOrder({ vendorUrl: arg('--url'), itemName: arg('--item'), qty: +arg('--qty', 1), autoSubmit: rest.includes('--auto'), record: rest.includes('--record') });
    console.log(JSON.stringify(r, null, 1));
    if (r.pageOpen) { console.log('Browser left open for you to finish/check the checkout. Ctrl+C when done.'); await new Promise(() => {}); }
  } else {
    console.log('usage: node src/cli.js <scrape [--meals lunch,tea]|login|remind|order --url U --item I [--qty N] [--auto] [--record]>');
  }
} finally {
  if (cmd !== 'order') await closeContext();
}
