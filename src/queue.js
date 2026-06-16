// Redis/BullMQ job backend. Active only when REDIS_URL is set; otherwise the
// app uses the in-memory registry in pipeline.js. The win: a render/dub/shorts
// job is persisted in Redis, so if the process dies the job is not lost — a
// worker (this process or a separate `npm run worker`) picks it up and runs it.
//
// The HEAVY work is the same processX(opts, ctx) functions the in-memory path
// uses (PROCESSORS in pipeline.js). This file only moves the job between Redis
// and those processors and translates progress/status to the shape the
// /api/job endpoints already expect. Nothing here is imported (and no Redis
// socket is opened) when REDIS_URL is empty.

import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import { PROCESSORS, resolveBatchVoices } from './pipeline.js';

export function queueEnabled() {
  return Boolean(config.redisUrl);
}

// BullMQ needs maxRetriesPerRequest=null on connections it uses for blocking
// commands. We lazily build connections so the memory path never touches Redis.
function makeConnection() {
  const conn = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  conn.on('error', (err) => console.error('[queue] redis connection error:', err.message));
  return conn;
}

let _conn = null;
let _queue = null;

function connection() {
  if (!_conn) _conn = makeConnection();
  return _conn;
}

function queue() {
  if (!_queue) _queue = new Queue(config.queueName, { connection: connection(), prefix: config.queuePrefix });
  return _queue;
}

// Job options. attempts:1 — a render is heavy and not safely retried on a real
// error, so a thrown failure stays failed. A worker that DIES mid-job is a
// different case: BullMQ's stalled-job recovery re-queues it (that's the
// "survives a restart" guarantee), independent of attempts.
const JOB_OPTS = {
  attempts: 1,
  removeOnComplete: { age: 24 * 3600, count: 200 },
  removeOnFail: { age: 7 * 24 * 3600, count: 200 },
};

/** Enqueue one job of `name` (render|dub|shorts|project-render). Returns its id. */
export async function enqueue(name, data) {
  const id = nanoid(10); // own id so the asset/project base matches the memory path
  await queue().add(name, data, { ...JOB_OPTS, jobId: id });
  return id;
}

/** Fan a multi-language batch out into N render jobs (same variants as memory). */
export async function enqueueMulti(opts) {
  const variants = resolveBatchVoices(opts); // throws if no valid voice → 400
  const batchId = nanoid(10);
  const jobs = [];
  for (const { voice, language } of variants) {
    const jobId = await enqueue('render', { ...opts, voice, voice2: null, batchId });
    jobs.push({ voice, language, jobId });
  }
  return { batchId, jobs };
}

// BullMQ state → the status vocabulary the in-memory job + the frontend use.
// waiting/active/delayed/paused all read as 'running'. Pure (gate-tested).
export function stateToStatus(s) {
  return s === 'completed' ? 'done' : s === 'failed' ? 'error' : 'running';
}

/**
 * Build the /api/job view from a BullMQ job + its state, in the SAME shape the
 * in-memory getJob produces: { id, kind, status, progress, plan, result, error,
 * log }. Pure, so the translation is gate-tested without a live Redis. The
 * cumulative log + plan ride inside the persisted progress payload the worker
 * writes via the accumulator below.
 */
export function viewFromState(job, state) {
  const p = job.progress && typeof job.progress === 'object' ? job.progress : {};
  return {
    id: job.id,
    kind: job.name,
    status: stateToStatus(state),
    progress: { stage: p.stage || 'init', message: p.message || '', pct: p.pct ?? 0 },
    plan: p.plan || null,
    result: job.returnvalue || null,
    error: job.failedReason || null,
    log: Array.isArray(p.log) ? p.log : [],
  };
}

export async function jobView(id) {
  const job = await queue().getJob(id);
  if (!job) return null;
  return viewFromState(job, await job.getState());
}

/**
 * Accumulate progress the way the worker reports it: a cumulative log, the
 * current stage/message/pct, and the plan. `snapshot()` is exactly the object
 * persisted via job.updateProgress, so viewFromState can reconstruct the live
 * view from it. Pure (gate-tested) — no Redis needed to prove the bookkeeping.
 */
export function progressAccumulator(initialPct = 0) {
  const log = [];
  let plan = null;
  let cur = { stage: 'init', message: '', pct: initialPct };
  return {
    get pct() { return cur.pct; },
    emit(stage, message, pct) { cur = { stage, message, pct }; log.push({ t: Date.now(), stage, message }); },
    setPlan(p) { plan = p; },
    snapshot() { return { ...cur, log: log.slice(), plan }; },
  };
}

/**
 * Worker-side progress reporter. Mirrors pipeline.js#memoryCtx but persists each
 * update to BullMQ (job.updateProgress) so /api/job can read it from any process.
 */
function redisCtx(job) {
  const acc = progressAccumulator((job.progress && job.progress.pct) || 0);
  // A progress-write failure must never kill a render, so swallow it.
  const push = () => job.updateProgress(acc.snapshot()).catch(() => {});
  return {
    id: job.id,
    get pct() { return acc.pct; },
    emit(stage, message, pct) { acc.emit(stage, message, pct); push(); },
    setPlan(p) { acc.setPlan(p); push(); },
  };
}

/**
 * Start a worker that pulls jobs and runs the matching processor. Used by the
 * dedicated `npm run worker` process and (when WORKER_INLINE) by the web server.
 * Returns the Worker, or null if Redis isn't configured.
 */
export function startWorker() {
  if (!queueEnabled()) return null;
  const worker = new Worker(
    config.queueName,
    async (job) => {
      const processor = PROCESSORS[job.name];
      if (!processor) throw new Error(`unknown job kind: ${job.name}`);
      return processor(job.data, redisCtx(job));
    },
    { connection: makeConnection(), prefix: config.queuePrefix, concurrency: config.workerConcurrency },
  );
  worker.on('completed', (job) => console.log(`[worker] ${job.name} ${job.id} done`));
  worker.on('failed', (job, err) => console.error(`[worker] ${job?.name} ${job?.id} failed:`, err?.message));
  worker.on('error', (err) => console.error('[worker] error:', err.message));
  return worker;
}

/** Wipe the queue's Redis keys (tests / a clean reset). */
export async function obliterate() {
  if (queueEnabled()) await queue().obliterate({ force: true });
}

/** Close the queue + shared connection (graceful shutdown / tests). */
export async function closeQueue() {
  if (_queue) { await _queue.close(); _queue = null; }
  if (_conn) { await _conn.quit().catch(() => {}); _conn = null; }
}
