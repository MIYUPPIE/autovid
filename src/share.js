// Share kit: turn a finished video into something a person can post anywhere.
//
// A rendered MP4 lives at /output/<file> on a local server. "Share on any
// platform" has two honest mechanisms, and this module powers both:
//
//   1. The OS share sheet (Web Share API, level 2). The browser hands the actual
//      MP4 file to the native sheet, which routes to *every* installed app —
//      Instagram, TikTok, WhatsApp, Messages, Drive. That's the real "any
//      platform" path and it needs no public hosting. The frontend drives it.
//   2. Per-network web composers (X, Facebook, LinkedIn, Reddit, WhatsApp,
//      Telegram, email) opened pre-filled with a tailored caption + link.
//
// Everything here is deterministic: same project in, same caption/hashtags/links
// out. No network, no LLM, no ffmpeg — so it is fast, free, and fully gate-tested.
// The link a post carries is whatever address the user reached the app on
// (request host, or SHARE_BASE_URL if they tunnel/host it); we never invent a
// public URL we can't back up.

import os from 'os';

// Words that carry no topical signal, so they make poor hashtags.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'at', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'this', 'that',
  'it', 'its', 'how', 'why', 'what', 'when', 'your', 'you', 'we', 'our', 'my',
]);

// Platforms whose web composer expects the video already in the post; the
// caption/url is just the text seed. Order = display order in the UI.
const STOPWORD_MIN_LEN = 3;

// X (Twitter) counts a posted link as 23 chars and caps the tweet at 280.
const TWEET_LIMIT = 280;
const TWEET_URL_COST = 23;

function titleCase(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Hashtags derived from a video's title + aspect. Deterministic and bounded:
 * topical words from the title (stopwords/short tokens dropped, title-cased)
 * plus the destination tags that match the aspect ratio (Shorts/Reels/TikTok
 * for vertical, YouTube for landscape). Case-insensitively de-duplicated and
 * capped so a caption never drowns in tags.
 */
export function buildHashtags({ title = '', aspect = '16:9', max = 8 } = {}) {
  const aspectTags = {
    '9:16': ['Shorts', 'Reels', 'TikTok'],
    '1:1': ['Reels'],
    '16:9': ['YouTube'],
  }[aspect] || [];

  const fromTitle = String(title)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= STOPWORD_MIN_LEN && !STOPWORDS.has(w.toLowerCase()))
    .slice(0, 5)
    .map(titleCase);

  const tags = [];
  const seen = new Set();
  for (const t of [...fromTitle, ...aspectTags]) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(`#${t}`);
    if (tags.length >= max) break;
  }
  return tags;
}

/**
 * The two caption variants a share needs:
 *   long  — title + a hashtag block, for Instagram/TikTok/WhatsApp/anywhere roomy.
 *   short — title trimmed (with up to 3 tags) so the whole tweet, including the
 *           23-char link cost, stays inside X's 280 limit.
 */
export function buildCaptions({ title = 'My video', hashtags = [] } = {}) {
  const cleanTitle = String(title).trim() || 'My video';
  const tagLine = hashtags.join(' ');
  const long = tagLine ? `${cleanTitle}\n\n${tagLine}` : cleanTitle;

  const shortTags = hashtags.slice(0, 3).join(' ');
  // Budget for the title once the link and tags are accounted for.
  const tagCost = shortTags ? shortTags.length + 1 : 0; // +1 for the joining space
  const budget = TWEET_LIMIT - TWEET_URL_COST - tagCost - 1; // -1 separator
  let head = cleanTitle;
  if (head.length > budget) head = `${head.slice(0, Math.max(0, budget - 1)).trimEnd()}…`;
  const short = shortTags ? `${head} ${shortTags}` : head;

  return { long, short };
}

/**
 * Pre-filled web-composer links for the text-capable networks. Each opens the
 * platform's own share dialog seeded with the caption + the video's link; the
 * user attaches/keeps the downloaded MP4 there. Pure URL construction.
 */
export function buildPlatformLinks({ url = '', title = '', captions = {} } = {}) {
  const u = encodeURIComponent(url);
  const short = encodeURIComponent(captions.short || title);
  const long = encodeURIComponent(captions.long || title);
  const t = encodeURIComponent(title);
  const longPlusUrl = encodeURIComponent(`${captions.long || title}\n${url}`);

  return [
    { id: 'x', label: 'X', href: `https://twitter.com/intent/tweet?text=${short}&url=${u}` },
    { id: 'whatsapp', label: 'WhatsApp', href: `https://wa.me/?text=${longPlusUrl}` },
    { id: 'facebook', label: 'Facebook', href: `https://www.facebook.com/sharer/sharer.php?u=${u}` },
    { id: 'telegram', label: 'Telegram', href: `https://t.me/share/url?url=${u}&text=${long}` },
    { id: 'linkedin', label: 'LinkedIn', href: `https://www.linkedin.com/sharing/share-offsite/?url=${u}` },
    { id: 'reddit', label: 'Reddit', href: `https://www.reddit.com/submit?url=${u}&title=${t}` },
    { id: 'email', label: 'Email', href: `mailto:?subject=${t}&body=${longPlusUrl}` },
  ];
}

/**
 * First non-internal IPv4 address as a base URL, so a phone on the same Wi-Fi
 * can open the app (and use its native share sheet) by scanning/typing it.
 * Returns null when there's no such interface (offline / loopback only).
 */
export function lanBaseUrl(port, protocol = 'http') {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return `${protocol}://${a.address}:${port}`;
    }
  }
  return null;
}

/**
 * Assemble the full share kit the frontend renders.
 *   project  — the loaded project doc (title/aspect/language).
 *   file     — basename of the rendered MP4 (served at /output/<file>).
 *   baseUrl  — the absolute origin the user reached the app on (no trailing /).
 *   lanUrl   — optional LAN origin for the "open on your phone" hint.
 */
export function buildShareKit({ project, file, baseUrl, lanUrl = null }) {
  const title = project.title || 'My video';
  const aspect = project.aspect || '16:9';
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const fileUrl = `${base}/output/${file}`;
  const hashtags = buildHashtags({ title, aspect });
  const captions = buildCaptions({ title, hashtags });
  const platforms = buildPlatformLinks({ url: fileUrl, title, captions });

  return {
    id: project.id,
    title,
    aspect,
    language: project.language || 'English',
    file,
    fileUrl,
    lanFileUrl: lanUrl ? `${lanUrl.replace(/\/+$/, '')}/output/${file}` : null,
    hashtags,
    captions,
    platforms,
  };
}
