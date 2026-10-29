const $ = (s) => document.querySelector(s);
const S = chrome.storage.local;
const mealBoxes = (id, sel) => { $('#' + id).innerHTML = Object.entries(MT.meals).map(([k, m]) => `<label><input type="checkbox" name="${id}" value="${k}" ${sel.includes(k) ? 'checked' : ''}> ${m.label}</label>`).join(''); };
const checked = (id) => [...document.querySelectorAll(`input[name="${id}"]:checked`)].map((i) => i.value);
(async () => {
  const st = { ...MT.defaults, ...((await S.get('settings')).settings || {}) };
  mealBoxes('scrapeMeals', st.scrapeMeals); mealBoxes('remindMeals', st.remindMeals);
  for (const k of ['menuUrl', 'scrapeEveryMin', 'minutesBeforeClose', 'note']) $('#' + k).value = st[k];
  for (const k of ['remindOnOpen', 'autoSubmit', 'recordNet']) $('#' + k).checked = !!st[k];
  $('#save').onclick = async () => {
    const settings = { scrapeMeals: checked('scrapeMeals'), remindMeals: checked('remindMeals'), menuUrl: $('#menuUrl').value.trim(), scrapeEveryMin: +$('#scrapeEveryMin').value || 30, minutesBeforeClose: +$('#minutesBeforeClose').value || 45, note: $('#note').value, remindOnOpen: $('#remindOnOpen').checked, autoSubmit: $('#autoSubmit').checked, recordNet: $('#recordNet').checked };
    await S.set({ settings }); $('#msg').textContent = '已儲存'; setTimeout(() => ($('#msg').textContent = ''), 1500);
  };
  $('#dump').onclick = async () => {
    const { netlog = [], pending, orders = [] } = await S.get(['netlog', 'pending', 'orders']);
    const blob = new Blob([JSON.stringify({ netlog, pending, orders }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `mangotree-lite-log-${Date.now()}.json`; a.click();
  };
})();
