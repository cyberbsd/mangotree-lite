# mangotree-lite

A thin local wrapper around [mangotree.tw](https://www.mangotree.tw/) that only shows **工業東一區**:
one screen with today's / tomorrow's vendors and dishes, a ⭐ favorites list for one-tap reorders,
and reminders when the ordering window opens or is about to close.

It does not replace the official site. Menu data comes from the public category/product pages;
the actual order still goes through mangotree.tw's own cart and checkout (login enforced there).

## Setup

```bash
npm install
npx playwright install chromium     # once; skip if you set MT_CHROME_PATH to an existing Chrome
cp .env.example .env                # fill MT_EMAIL / MT_PASSWORD, optional NTFY_TOPIC or Telegram
npm start                           # http://localhost:3456
```

First start scrapes the menu (≈1–2 min, roughly 50 page loads), then re-scrapes every
`scrapeEveryMinutes` (config.json) and evaluates reminders every minute while it runs.

## How ordering works

Pick a dish → **訂**. Three ways to finish:

1. **用 Playwright 下單** – opens a visible Chromium using the saved profile (`./profile`), logs in with
   the credentials from `.env` if needed, selects the variation, adds to cart and lands on `/checkout`.
   By default it stops there so you press the final button yourself; tick **自動送出訂單** to let it try.
   Tick **記錄 API** to dump every XHR the storefront makes into `data/netlog-*.jsonl`
   (useful to tighten the selectors / switch to direct API calls later).
2. **複製 Claude in Chrome 指令** – copies a short instruction you paste into Claude in Chrome, which
   then orders inside your own logged-in Chrome (no stored password, no captcha issues). Press
   **我已手動訂好** afterwards so reminders go quiet for that slot.
3. **開官網商品頁** – plain deep link to the vendor page.

## Reminders

`config.json → reminders`:

| key | meaning |
|---|---|
| `meals` | which meals to nag about (`lunch`, `tea`, `dinner-early`, `dinner-late`) |
| `onOpen` | notify when a slot opens (lunch for day D opens at 16:00 on D-1) |
| `minutesBeforeClose` | notify N min before the cutoff (lunch cutoff is 09:50 on day D) if nothing was ordered |
| `quietIfOrdered` | skip when an order for that slot/date is recorded in `data/orders.json` |

Window times are read from each vendor's `available_start_time` / `available_end_time`, so they track
whatever the store sets. Channels: [ntfy](https://ntfy.sh) topic (phone push, zero setup) and/or a
Telegram bot. LINE Notify was shut down in 2025, so it is not an option.

Keep `npm start` running (pm2, a login item, or Task Scheduler) or run `npm run remind` from cron.

## CLI

```bash
npm run scrape -- --meals lunch,tea      # refresh data/menu.json
npm run login                            # one-off interactive login into ./profile
npm run remind                           # evaluate reminders once
node src/cli.js order --url <vendor product url> --item "精緻燒肉飯 $85" --qty 1 [--auto] [--record]
```

## Notes

* Category slugs are stable per weekday (`gongye-e-1-<mon|tues|wed|thur|fri>-<lunch|afternoon-tea|dinner-early|dinner-late>`);
  the actual date is parsed from the page title, e.g. `(午)(工業東一區) 10/30(五)`.
* Plain `curl` gets SHOPLINE's "site busy" shield page, which is why scraping goes through a real browser.
* The store has reCAPTCHA Enterprise on login. If automated login is challenged, finish it once in the
  visible window; the session cookie then lives in `./profile`.
* Checkout selectors in `src/order.js` for the final submit button are best-effort (the checkout page
  needs a login to inspect). Run one order with **記錄 API** and adjust if needed.

## Chrome / Edge extension (one-click order)

`extension/` is a Manifest V3 extension that does the whole thing inside your own logged-in browser:
no stored password, no captcha, no Playwright.

Install: `chrome://extensions` (or `edge://extensions`) → Developer mode → **Load unpacked** → pick the
`extension` folder. Pin the 🥭 icon.

* **Popup**: same one-screen menu (tabs per meal/date, vendors → dishes with stock, ⭐ favorites).
  First open scrapes the menu itself (≈1 min); afterwards every 30 min via `chrome.alarms`.
  In ⚙ settings you can instead point it at the GitHub Pages `menu.json` to skip self-scraping.
* **訂** opens the vendor page with a marker, and the content script drives SHOPLINE's own AngularJS
  controller (`variationName[i]` → `onVariationChanged(i)` → `addItemQuantity` → `addItemToCart()`),
  then goes to `/checkout`, fills the 注意事項 textarea with your note and ticks any agreement box.
  By default it stops there; you press the final button. Enable **自動按最後的送出按鈕** once you've
  seen the flow work.
* **Reminders** are Chrome notifications (works while the browser is running): on window open and
  N minutes before cutoff, silenced once an order for that slot is recorded.
* **記錄官網 API 呼叫** logs the storefront's XHR/fetch calls; **匯出紀錄** downloads them as JSON.
  Send that file if the add-to-cart step misbehaves and the selectors need adjusting.

Phones: Chrome on Android/iOS has no extensions, so colleagues on phones use the GitHub Pages site.

## Weekly rotation

MangoTree publishes the next week's vendors every Saturday, with new product IDs. Favorites are
therefore matched by vendor **name** + dish name with the trailing price ignored, so "精緻燒肉飯 $85"
still matches next week's "精緻燒肉飯 $90". When a new week's menu appears, the reminder job sends one
notice listing which days your favorites are on; `data/state.json` (committed by the workflow) remembers
the last week seen.
