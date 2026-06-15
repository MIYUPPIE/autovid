import fetch from 'node-fetch';

// Browser-like headers for CDN downloads. cdn.pixabay.com (and many stock CDNs)
// sit behind Cloudflare, which challenges or resets connections that send the
// default `User-Agent: node-fetch` — especially from datacenter/VPS IPs. A real
// browser UA gets waved through, so without this a VPS deploy can fail EVERY
// download while a laptop on a home connection works fine.
export const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

// node-fetch leaves `.message` empty for some socket/TLS resets, which is why the
// UI showed "download failed: request to … failed, reason:" with nothing after.
// Dig the actual cause out of the error so failures are always actionable.
export function netReason(err) {
  const name = err && err.name && err.name !== 'Error' ? err.name : null; // skip useless "Error"
  return (
    (err && err.message) ||
    (err && err.code) ||
    (err && err.cause && (err.cause.code || err.cause.message)) ||
    (err && err.type) ||
    name ||
    'network error'
  );
}

// HTTP statuses worth retrying: Cloudflare/WAF throttles and upstream blips.
const TRANSIENT = new Set([403, 408, 425, 429, 500, 502, 503, 504]);

/**
 * Stream a URL to disk with browser headers, an idle-stall timeout, a size cap,
 * and retries on transient failures. Returns the dest path. Throws an Error with
 * a real, non-empty message on permanent failure.
 *
 * @param {string} url
 * @param {string} dest absolute file path to write
 * @param {object} opts { idleTimeout, maxBytes, minBytes, attempts, headers }
 */
export async function downloadToFile(url, dest, opts = {}) {
  const {
    idleTimeout = 30000,
    maxBytes = Infinity,
    minBytes = 0,
    attempts = 3,
    headers = BROWSER_HEADERS,
  } = opts;
  const fs = await import('fs');
  const { pipeline } = await import('stream/promises');

  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    let timer;
    let oversize = false;
    const armIdle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), idleTimeout);
    };
    try {
      armIdle();
      const res = await fetch(url, { signal: controller.signal, headers, redirect: 'follow' });
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status}`);
        if (!TRANSIENT.has(res.status)) e.fatal = true; // 404 etc: don't waste retries
        throw e;
      }
      const declared = Number(res.headers.get('content-length') || 0);
      if (declared && declared > maxBytes) {
        throw Object.assign(new Error(`too large (${Math.round(declared / 1e6)}MB cap ${Math.round(maxBytes / 1e6)}MB)`), { fatal: true });
      }
      let got = 0;
      res.body.on('data', (chunk) => {
        armIdle();
        got += chunk.length;
        if (got > maxBytes) { oversize = true; controller.abort(); }
      });
      await pipeline(res.body, fs.createWriteStream(dest));
      clearTimeout(timer);
      if (oversize) throw Object.assign(new Error(`too large (> ${Math.round(maxBytes / 1e6)}MB)`), { fatal: true });
      const { size } = fs.statSync(dest);
      if (size < minBytes) throw new Error(`truncated download (${size} bytes)`);
      return dest;
    } catch (err) {
      clearTimeout(timer);
      try { fs.unlinkSync(dest); } catch { /* nothing to clean */ }
      lastErr = err;
      if (err.fatal || attempt >= attempts) break;
      await new Promise((r) => setTimeout(r, 400 * attempt)); // linear backoff
    }
  }
  throw new Error(netReason(lastErr));
}
