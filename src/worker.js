// Dedicated queue worker: `npm run worker`. Pulls render/dub/shorts/project-
// render jobs from Redis and runs them, separate from the web server so a web
// restart never interrupts a render and workers can scale horizontally. For a
// single box you don't need this — `npm start` runs an inline worker unless
// WORKER_INLINE=0.

import { config } from './config.js';
import { startWorker, queueEnabled } from './jobs.js';

if (!queueEnabled()) {
  // Not an error — with the in-memory backend the web process runs work inline,
  // so a dedicated worker has nothing to do. Exit 0 so a process manager treats
  // it as a clean stop (see stop_exit_codes in ecosystem.config.cjs), not a
  // crash to restart in a loop.
  console.log('\n  No REDIS_URL set — in-memory backend runs work inline in the web process.');
  console.log('  The dedicated worker is only needed with Redis; nothing to do, exiting.\n');
  process.exit(0);
}

const worker = startWorker();
console.log(`\n  GriotVid worker → queue "${config.queueName}" on ${config.redisUrl}`);
console.log(`  concurrency=${config.workerConcurrency}\n`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\n  ${sig} — draining worker…`);
    try { await worker.close(); } catch { /* ignore */ }
    process.exit(0);
  });
}
