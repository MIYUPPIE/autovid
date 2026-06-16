// Queue eval: proves the Redis/BullMQ backend end-to-end through OUR code
// (enqueue → worker dispatch → redisCtx progress → jobView), plus the core
// promise that justifies the queue: a job enqueued while NO worker is running
// (the "server restarted mid-flow" case) is NOT lost — it sits in Redis and a
// worker runs it to completion when it comes back.
//
// Paid/integration lane: needs a reachable Redis. Skips (exit 0) if there isn't
// one, so it never blocks a machine without Redis. Run: npm run eval:queue
//   REDIS_URL=redis://host:6379 npm run eval:queue

import assert from 'node:assert/strict';
import IORedis from 'ioredis';

// A throwaway queue name so we never touch a real app's keys. Set BEFORE config
// is imported (config snapshots env at load).
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.QUEUE_NAME = `griotvid_smoke_${Date.now()}`;
process.env.QUEUE_PREFIX = 'griotvid_smoke';
process.env.WORKER_CONCURRENCY = '2';

const REDIS_URL = process.env.REDIS_URL;

async function redisReachable() {
  const conn = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true, connectTimeout: 2000 });
  conn.on('error', () => {}); // swallow the connect-refused noise; we report via the return value
  try { await conn.connect(); await conn.ping(); return true; }
  catch { return false; }
  finally { conn.disconnect(); }
}

// Poll jobView until it leaves 'running' (or times out). Returns the final view.
async function waitDone(q, id, ms = 15000) {
  const t0 = Date.now();
  let v = await q.jobView(id);
  while (Date.now() - t0 < ms && v && v.status === 'running') {
    await new Promise((r) => setTimeout(r, 100));
    v = await q.jobView(id);
  }
  return v;
}

async function main() {
  if (!(await redisReachable())) {
    console.log(`\n  ⚠ SKIP queue smoke — no Redis at ${REDIS_URL}.`);
    console.log('    Start one (`sudo apt install -y redis-server` / `docker run -p 6379:6379 redis`) and re-run.\n');
    process.exit(0);
  }

  const q = await import('../src/queue.js');
  const { PROCESSORS } = await import('../src/pipeline.js');

  assert.equal(q.queueEnabled(), true, 'REDIS_URL set → queue enabled');

  // Register test-only processors on the SAME registry the worker dispatches
  // from, so this exercises the real enqueue/worker/ctx/jobView path.
  PROCESSORS.smoke = async (data, ctx) => {
    ctx.emit('work', 'step 1', 33);
    ctx.setPlan({ title: `plan for ${data.n}` });
    await new Promise((r) => setTimeout(r, 60));
    ctx.emit('work', 'step 2', 66);
    ctx.emit('done', 'finished', 100);
    return { echo: data.n, doubled: data.n * 2 };
  };
  PROCESSORS.smokefail = async () => { throw new Error('intentional smoke failure'); };

  let worker = null;
  let failures = 0;
  const check = (label, fn) => { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { failures++; console.log(`  ✗ ${label}: ${e.message}`); } };

  try {
    console.log(`\n  Queue smoke → ${REDIS_URL} (queue "${process.env.QUEUE_NAME}")\n`);

    // 1) RESTART SURVIVAL: enqueue with no worker running, then start one.
    const id = await q.enqueue('smoke', { n: 21 });
    check('enqueue returns a string job id', () => assert.equal(typeof id, 'string'));
    const pending = await q.jobView(id);
    check('a queued job persists in Redis before any worker runs (status running, no result)', () => {
      assert.ok(pending);
      assert.equal(pending.status, 'running');
      assert.equal(pending.result, null);
    });

    // Worker comes online (the "server came back" moment) and drains the job.
    worker = q.startWorker();
    const done = await waitDone(q, id);
    check('the worker picks up the waiting job and completes it', () => assert.equal(done.status, 'done'));
    check('result is the processor return value', () => assert.deepEqual(done.result, { echo: 21, doubled: 42 }));
    check('progress reached 100 and the cumulative log streamed through', () => {
      assert.equal(done.progress.pct, 100);
      assert.ok(done.log.length >= 3, `expected >=3 log entries, got ${done.log.length}`);
      assert.ok(done.log.some((e) => e.stage === 'done'));
    });
    check('setPlan rode along in the persisted progress payload', () => assert.equal(done.plan.title, 'plan for 21'));

    // 2) FAILURE PATH: a throwing processor surfaces as status 'error' + reason.
    const failId = await q.enqueue('smokefail', {});
    const failed = await waitDone(q, failId);
    check('a thrown processor error surfaces as status error with the message', () => {
      assert.equal(failed.status, 'error');
      assert.match(failed.error || '', /intentional smoke failure/);
    });

    // 3) Unknown id → null (matches the in-memory contract).
    check('jobView is null for an unknown id', async () => {});
    assert.equal(await q.jobView('nope-not-real'), null);
  } finally {
    if (worker) await worker.close();
    await q.obliterate().catch(() => {});
    await q.closeQueue().catch(() => {});
  }

  if (failures) { console.log(`\n  FAIL — ${failures} check(s) failed.\n`); process.exit(1); }
  console.log('\n  PASS — queue persists jobs across a worker restart and reports status correctly.\n');
  process.exit(0);
}

main().catch((err) => { console.error('queue smoke crashed:', err); process.exit(1); });
