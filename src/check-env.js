import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from './config.js';

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

console.log('\nAutoVid environment check\n');
await check('ffmpeg', async () => (await execFileP('ffmpeg', ['-version'])).stdout.split('\n')[0]);
await check('ffprobe', async () => (await execFileP('ffprobe', ['-version'])).stdout.split('\n')[0]);
await check('edge-tts', async () => {
  const { stdout } = await execFileP('edge-tts', ['--list-voices']);
  return `${stdout.split('\n').length} voices available`;
});
await check('mms-tts python (Yoruba/Igbo/Hausa)', async () => {
  const { stdout } = await execFileP(config.mmsPython, ['-c',
    'import torch,transformers;print("torch",torch.__version__,"cuda",torch.cuda.is_available())']);
  return stdout.trim();
});
console.log('\nAPI keys:');
console.log(`  ${config.xaiKey ? '✓' : '✗'} XAI_API_KEY`);
console.log(`  ${config.pexelsKey ? '✓' : '✗'} PEXELS_API_KEY`);
console.log(`  ${config.pixabayKey ? '✓' : '✗'} PIXABAY_API_KEY`);
console.log(`  ${config.jamendoClientId ? '✓' : '✗'} JAMENDO_CLIENT_ID  (auto background music)`);
console.log('');
