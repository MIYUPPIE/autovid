// pm2 process file for a VPS deploy: `pm2 start ecosystem.config.cjs`.
//
// - griotvid-web    : the HTTP server + UI (always needed).
// - griotvid-worker : a dedicated queue worker. Only does anything when
//                     REDIS_URL is set; with the in-memory backend it exits
//                     immediately (the web process runs work inline), so it
//                     just sits stopped — harmless.
//
// For a single box you can skip the worker entirely and let the web process run
// an inline worker (WORKER_INLINE defaults to 1). Set WORKER_INLINE=0 in the
// environment when you run the dedicated worker so the web server only enqueues.
//
// Both inherit the shell environment (and the project's .env via dotenv), so set
// REDIS_URL / keys there or in your process manager — not hard-coded here.

module.exports = {
  apps: [
    {
      name: 'griotvid-web',
      script: 'src/server.js',
      instances: 1,            // single instance: it owns the SSE streams + static assets
      autorestart: true,
      max_memory_restart: '1G',
      // Enqueue-only: the dedicated worker below does the heavy ffmpeg work, so
      // the web process stays responsive and isn't competing for the GPU. With
      // the in-memory backend (no REDIS_URL) this flag is ignored and work runs
      // inline here as usual.
      env: { NODE_ENV: 'production', WORKER_INLINE: '0' },
    },
    {
      name: 'griotvid-worker',
      script: 'src/worker.js',
      instances: 1,            // raise for more parallel renders (needs the cores/GPU)
      autorestart: true,
      // Without REDIS_URL the worker is a no-op and exits 0 — treat that as a
      // clean stop so pm2 doesn't restart-loop it on a single in-memory box.
      stop_exit_codes: [0],
      env: { NODE_ENV: 'production' },
    },
  ],
};
