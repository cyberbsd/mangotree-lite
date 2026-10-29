import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const PROFILE_DIR = path.join(ROOT, 'profile');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
export const env = {
  email: process.env.MT_EMAIL || '',
  password: process.env.MT_PASSWORD || '',
  headless: (process.env.MT_HEADLESS || 'false').toLowerCase() === 'true',
  port: Number(process.env.PORT || 3456),
  ntfyTopic: process.env.NTFY_TOPIC || '',
  tgToken: process.env.TELEGRAM_BOT_TOKEN || '',
  tgChat: process.env.TELEGRAM_CHAT_ID || '',
};

export const TZ = 'Asia/Taipei';
export const DAY_SLUGS = ['mon', 'tues', 'wed', 'thur', 'fri'];
export const DAY_ZH = { mon: '一', tues: '二', wed: '三', thur: '四', fri: '五' };

export function categorySlug(mealKey, day) {
  return `${cfg.area.slug}-${day}-${cfg.meals[mealKey].suffix}`;
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch { return fallback; }
}
export function writeJson(file, obj) {
  const p = path.join(DATA_DIR, file);
  fs.writeFileSync(p + '.tmp', JSON.stringify(obj, null, 1));
  fs.renameSync(p + '.tmp', p);
}

/** Format a Date/ISO string in Taipei time: "10/30(五) 09:50" */
export function fmtTW(d, withDate = true) {
  if (!d) return '';
  const dt = new Date(d);
  const parts = new Intl.DateTimeFormat('zh-TW', { timeZone: TZ, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'narrow' }).formatToParts(dt);
  const g = (t) => parts.find((p) => p.type === t)?.value || '';
  const time = `${g('hour')}:${g('minute')}`;
  return withDate ? `${g('month')}/${g('day')}(${g('weekday')}) ${time}` : time;
}
