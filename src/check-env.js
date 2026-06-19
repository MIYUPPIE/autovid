import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from './config.js';
import { verifyYarn } from './voice.js';

const execFileP = promisify(execFile);

async function check(name, fn) {
  try {
    const v = await fn();
    console.log(`  ✓ ${name}: ${v}`);
    return true;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message.split('\n')[0]}`);
    return false;
  }
}

console.log('\nGriotVid environment check\n');
await check('ffmpeg', async () => (await execFileP('ffmpeg', ['-version'])).stdout.split('\n')[0]);
await check('ffprobe', async () => (await execFileP('ffprobe', ['-version'])).stdout.split('\n')[0]);
await check('edge-tts', async () => {
  const { stdout } = await execFileP('edge-tts', ['--list-voices']);
  return `${stdout.split('\n').length} voices available`;
});
console.log('\nAPI keys:');
console.log(`  ${config.xaiKey ? '✓' : '✗'} XAI_API_KEY`);
console.log(`  ${config.pexelsKey ? '✓' : '✗'} PEXELS_API_KEY`);
console.log(`  ${config.pixabayKey ? '✓' : '✗'} PIXABAY_API_KEY`);
console.log(`  ${config.jamendoClientId ? '✓' : '✗'} JAMENDO_CLIENT_ID  (auto background music)`);
// Live probe, not just key-presence: YarnGPT 500s when a key is present but
// rejected, so "set" never meant "works". This catches a bad/expired key here
// instead of mid-render.
if (config.yarnKey) {
  const v = await verifyYarn().catch((e) => ({ ok: false, message: e.message }));
  console.log(`  ${v.ok ? '✓' : '✗'} YARN_API_KEY  (Yoruba/Igbo/Hausa voices) — ${v.message}`);
} else {
  console.log('  ✗ YARN_API_KEY  (Yoruba/Igbo/Hausa voices) — not set');
}
console.log(`  ${config.xaiKey ? '✓' : '✗'} XAI_API_KEY  → AI talking video (${config.xaiVideoModel} @ ${config.xaiVideoBase}${config.xaiVideoPath}, ${config.xaiVideoResolution})`);

console.log('\nLocal AI video (free, your GPU):');
await check(`python (${config.localvidPython})`, async () => {
  const { stdout } = await execFileP(config.localvidPython, ['--version']);
  return stdout.trim() || 'ok';
});
await check('torch + CUDA + diffusers', async () => {
  const code = 'import torch,diffusers;print("torch",torch.__version__,"| cuda",torch.cuda.is_available(),"|",(torch.cuda.get_device_name(0) if torch.cuda.is_available() else "no-gpu"),"| diffusers",diffusers.__version__)';
  const { stdout } = await execFileP(config.localvidPython, ['-c', code], { timeout: 60000 });
  return stdout.trim();
});

console.log('\nJob queue:');
if (!config.redisUrl) {
  console.log('  • in-memory (no REDIS_URL) — jobs run inline and are lost if the process restarts');
} else {
  // Reachability check so a bad REDIS_URL is caught before the first render.
  await check(`redis (${config.redisUrl})`, async () => {
    const { default: IORedis } = await import('ioredis');
    const conn = new IORedis(config.redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true, connectTimeout: 3000 });
    conn.on('error', () => {}); // the check() wrapper reports the failure; don't let ioredis log it too
    try { await conn.connect(); const pong = await conn.ping(); return `${pong} — BullMQ backend ready (queue "${config.queueName}")`; }
    finally { conn.disconnect(); }
  });
}
console.log('');
