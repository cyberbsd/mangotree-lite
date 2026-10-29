// Static config shared by background, popup and options.
const MT = {
  base: 'https://www.mangotree.tw',
  area: { slug: 'gongye-e-1', name: '工業東一區' },
  meals: {
    lunch:          { label: '午餐',       days: ['mon', 'tues', 'wed', 'thur', 'fri'], suffix: 'lunch' },
    tea:            { label: '下午茶',     days: ['tues', 'wed', 'thur'],               suffix: 'afternoon-tea' },
    'dinner-early': { label: '晚餐早點拿', days: ['mon', 'tues', 'wed', 'thur', 'fri'], suffix: 'dinner-early' },
    'dinner-late':  { label: '晚餐晚點拿', days: ['mon', 'tues', 'wed', 'thur', 'fri'], suffix: 'dinner-late' },
  },
  dayZh: { mon: '一', tues: '二', wed: '三', thur: '四', fri: '五' },
  defaults: {
    scrapeMeals: ['lunch'],          // which meals the extension scrapes itself
    scrapeEveryMin: 30,
    menuUrl: '',                     // optional: GitHub Pages menu.json; when set, used instead of self-scrape
    remindMeals: ['lunch'],
    remindOnOpen: true,
    minutesBeforeClose: 45,
    autoSubmit: false,               // press the final place-order button automatically
    note: '',                        // text for the store's 注意事項 textarea at checkout
    recordNet: false,                // log the storefront's XHR calls to storage (for debugging)
  },
};
if (typeof globalThis !== 'undefined') globalThis.MT = MT;
