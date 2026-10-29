import { env } from './config.js';

/** Send a reminder through every configured channel. Always also prints to stdout. */
export async function notify(title, body, { url } = {}) {
  console.log(`[notify] ${title} — ${body}${url ? ' ' + url : ''}`);
  const jobs = [];
  if (env.ntfyTopic) {
    jobs.push(fetch(`https://ntfy.sh/${encodeURIComponent(env.ntfyTopic)}`, {
      method: 'POST', body, headers: { Title: title, Priority: 'high', Tags: 'bento', ...(url ? { Click: url } : {}) },
    }).catch((e) => console.error('ntfy failed:', e.message)));
  }
  if (env.tgToken && env.tgChat) {
    jobs.push(fetch(`https://api.telegram.org/bot${env.tgToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.tgChat, text: `${title}\n${body}${url ? '\n' + url : ''}` }),
    }).catch((e) => console.error('telegram failed:', e.message)));
  }
  await Promise.all(jobs);
}
