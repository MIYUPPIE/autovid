import { runShorts } from '/home/okhub/Documents/PROJECTS/autovid/autovid v2/src/pipeline.js';
import { getJob } from '/home/okhub/Documents/PROJECTS/autovid/autovid v2/src/pipeline.js';
const id = runShorts({ videoPath: 'assets/output/6oBtrxGZBA_final.mp4', count: 2, model: 'tiny', minSec: 8, maxSec: 20 });
console.log('job', id);
const t0 = Date.now();
const poll = setInterval(() => {
  const j = getJob(id);
  if (!j) return;
  process.stdout.write(`\r[${((Date.now()-t0)/1000).toFixed(0)}s] ${j.status} ${j.progress.pct}% ${j.progress.message}        `);
  if (j.status === 'done' || j.status === 'error') {
    clearInterval(poll);
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify(j.result || j.error, null, 2));
    process.exit(0);
  }
}, 500);
