// Job facade. One door the server calls to start work and read its status,
// regardless of backend: the in-memory registry (default) or the Redis/BullMQ
// queue (when REDIS_URL is set). Every submit* returns a Promise<jobId> and
// jobView returns a Promise so the server has ONE async shape to await — the
// memory path just resolves synchronously underneath.

import {
  runPipeline, runMultiPipeline, runDub, runShorts, startProjectRender, getJob, runAiVideo, runLocalVideo,
} from './pipeline.js';
import { loadProject } from './project.js';
import * as q from './queue.js';

export const queueEnabled = q.queueEnabled;
export const startWorker = q.startWorker;

/** 'redis' when a queue is configured, else 'memory'. Surfaced in /api/health. */
export function activeBackend() {
  return q.queueEnabled() ? 'redis' : 'memory';
}

export async function submitRender(opts) {
  return q.queueEnabled() ? q.enqueue('render', opts) : runPipeline(opts);
}

export async function submitMulti(opts) {
  return q.queueEnabled() ? q.enqueueMulti(opts) : runMultiPipeline(opts);
}

export async function submitDub(opts) {
  return q.queueEnabled() ? q.enqueue('dub', opts) : runDub(opts);
}

export async function submitShorts(opts) {
  return q.queueEnabled() ? q.enqueue('shorts', opts) : runShorts(opts);
}

export async function submitAiVideo(opts) {
  return q.queueEnabled() ? q.enqueue('ai-video', opts) : runAiVideo(opts);
}

export async function submitLocalVideo(opts) {
  return q.queueEnabled() ? q.enqueue('local-video', opts) : runLocalVideo(opts);
}

export async function submitProjectRender(projectId) {
  // Check existence up front so the endpoint can 404 instead of enqueuing a job
  // that's doomed to fail in the worker.
  if (q.queueEnabled()) {
    if (!loadProject(projectId)) return null;
    return q.enqueue('project-render', { projectId });
  }
  return startProjectRender(projectId);
}

export async function jobView(id) {
  return q.queueEnabled() ? q.jobView(id) : (getJob(id) || null);
}
