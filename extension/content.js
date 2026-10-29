// Isolated-world content script: reads the pending order from storage, drives content-main.js, reports back.
(async () => {
  const S = chrome.storage.local;
  const get = async (k, d) => (await S.get(k))[k] ?? d;
  const settings = { ...MTDefaults(), ...(await get('settings', {})) };
  function MTDefaults() { return { autoSubmit: false, note: '', recordNet: false }; }

  const call = (cmd, args, timeout = 60000) => new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const on = (ev) => { if (ev.detail?.id !== id) return; window.removeEventListener('mtl:res', on); ev.detail.ok ? resolve(ev.detail.result) : reject(new Error(ev.detail.error)); };
    window.addEventListener('mtl:res', on);
    window.dispatchEvent(new CustomEvent('mtl:cmd', { detail: { id, cmd, args } }));
    setTimeout(() => { window.removeEventListener('mtl:res', on); reject(new Error(cmd + ' timed out')); }, timeout);
  });

  if (settings.recordNet) {
    call('net', {}).catch(() => {});
    window.addEventListener('mtl:net', async (ev) => { const l = await get('netlog', []); l.push(ev.detail); await S.set({ netlog: l.slice(-500) }); });
  }

  const banner = (text, color = '#d9913c') => {
    let b = document.getElementById('mtl-banner');
    if (!b) { b = document.createElement('div'); b.id = 'mtl-banner'; b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;padding:10px 16px;font:15px/1.4 system-ui,sans-serif;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3)'; document.documentElement.appendChild(b); }
    b.style.background = color; b.textContent = '🥭 MangoTree Lite：' + text;
  };

  const pending = await get('pending');
  if (!pending) return;
  const logTo = async (line) => { const p = await get('pending'); if (!p) return; p.log.push(`${new Date().toLocaleTimeString()} ${line}`); await S.set({ pending: p }); };
  const stale = Date.now() - pending.startedAt > 10 * 60 * 1000;
  if (stale) { await S.remove('pending'); return; }

  const here = location.href;
  const isProduct = here.includes('/products/') && new URL(here).searchParams.get('mtl') === pending.id;
  const isCheckout = /\/checkout/.test(location.pathname);

  try {
    if (isProduct && pending.stage === 'add') {
      const mine = (l) => !l.done && l.vendorUrl.split('?')[0] === here.split('?')[0];
      if (!(await call('user', {}, 15000))) {
        banner('尚未登入 mangotree.tw，3 秒後帶你去登入；登入後再按一次「一次結帳」。', '#c0392b'); await logTo('not logged in'); await S.remove('pending');
        setTimeout(() => { location.href = 'https://www.mangotree.tw/users/sign_in'; }, 3000); return;
      }
      for (const line of pending.items.filter(mine)) {
        const p = await get('pending'); if (!p) return;
        banner(`加入購物車（${p.done + 1}/${p.items.length}）：${line.itemName} ×${line.qty || 1} …`);
        const r = await call('add', { itemName: line.itemName, qty: line.qty || 1 });
        const idx = p.items.findIndex((l) => !l.done && l.itemName === line.itemName && l.vendorUrl === line.vendorUrl);
        if (idx >= 0) p.items[idx].done = true;
        p.done = p.items.filter((l) => l.done).length; p.log.push(`${new Date().toLocaleTimeString()} added ${line.itemName}: ${JSON.stringify(r).slice(0, 200)}`);
        await S.set({ pending: p });
        await new Promise((r) => setTimeout(r, 1200));
      }
      const p = await get('pending'); if (!p) return;
      const next = p.items.find((l) => !l.done);
      if (next) { banner(`前往 ${next.vendorName} …`, '#2e8b57'); location.href = next.vendorUrl.split('?')[0] + '?mtl=' + p.id; return; }
      await S.set({ pending: { ...p, stage: 'checkout' } });
      banner('全部加入購物車，前往結帳…', '#2e8b57');
      location.href = 'https://www.mangotree.tw/checkout';
    } else if (isCheckout && pending.stage === 'checkout') {
      banner(settings.autoSubmit ? '結帳中，自動送出…' : '結帳頁已備好，請按最後的送出按鈕。');
      const r = await call('checkout', { note: settings.note, autoSubmit: settings.autoSubmit }, 45000);
      await logTo('checkout: ' + JSON.stringify(r));
      const order = { slotKey: pending.slotKey, date: pending.date, items: pending.items.map(({ vendorName, itemName, qty }) => ({ vendorName, itemName, qty: qty || 1 })), submitted: r.submitted, auto: settings.autoSubmit };
      if (r.submitted) { await S.remove('pending'); chrome.runtime.sendMessage({ type: 'ordered', order }); banner('已送出訂單 ✅（請到會員中心確認）', '#2e8b57'); }
      else {
        // Watch for the confirmation page after the human presses submit.
        await S.set({ pending: { ...(await get('pending')), stage: 'confirm' } });
        const t = setInterval(async () => { if (/\/orders\/|thank|confirm/i.test(location.href)) { clearInterval(t); await S.remove('pending'); chrome.runtime.sendMessage({ type: 'ordered', order: { ...order, submitted: true } }); } }, 1000);
        window.addEventListener('beforeunload', async () => { /* order page loads next; mark optimistic */ await S.remove('pending'); chrome.runtime.sendMessage({ type: 'ordered', order: { ...order, submitted: true, optimistic: true } }); });
      }
    }
  } catch (e) {
    await logTo('ERROR ' + e.message);
    banner('失敗：' + e.message + '（可手動完成）', '#c0392b');
    await S.remove('pending');
  }
})();
