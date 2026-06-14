// Periodic eval: measures the QUALITY of Grok's scene plans. Paid (real xAI calls),
// slower, non-deterministic — but gated by a hard pass threshold.
// Run: npm run eval     (requires XAI_API_KEY)
import { generateVideoPlan } from '../src/xai.js';
import { config } from '../src/config.js';

const PASS_THRESHOLD = 0.85; // fraction of checks that must pass across all cases

const CASES = [
  { topic: 'How solar mini-grids power rural Nigerian markets', context: 'africa',  targetSeconds: 30, tone: 'documentary' },
  { topic: 'Why street food markets define a city',            context: 'global',  targetSeconds: 45, tone: 'energetic' },
  { topic: 'The rise of mobile money in East Africa',          context: 'africa',  targetSeconds: 60, tone: 'engaging' },
  { topic: 'The story of Ibadan city',                         context: 'africa',  targetSeconds: 30, tone: 'documentary', language: 'Yoruba' },
];

const NON_ASCII = /[^\x00-\x7F]/;
const ASCII_ONLY = /^[\x00-\x7F]+$/;
const wordCount = (s) => s.trim().split(/\s+/).filter(Boolean).length;

function checkPlan(plan, c) {
  const checks = [];
  const add = (name, ok) => checks.push({ name, ok: Boolean(ok) });

  add('title is a non-empty string', typeof plan.title === 'string' && plan.title.trim().length > 0);
  add('hook is present', typeof plan.hook === 'string' && plan.hook.trim().length > 0);
  add('has 3+ scenes', Array.isArray(plan.scenes) && plan.scenes.length >= 3);
  add('scene count within budget', plan.scenes.length <= config.maxScenes);

  const scenes = plan.scenes || [];
  add('every scene has narration', scenes.every((s) => s.narration && s.narration.trim().length > 0));
  add('every query is 1-6 words', scenes.every((s) => { const w = wordCount(s.query || ''); return w >= 1 && w <= 6; }));
  add('every duration in 2-20s', scenes.every((s) => s.durationSec >= 2 && s.durationSec <= 20));

  const total = scenes.reduce((a, s) => a + s.durationSec, 0);
  add(`durations (~${total}s) within 50% of ${c.targetSeconds}s target`,
    total >= c.targetSeconds * 0.5 && total <= c.targetSeconds * 1.5);

  // Narration should be roughly speakable in the allotted time (~2.5 wps, generous bound).
  add('narration roughly speakable in its window',
    scenes.every((s) => wordCount(s.narration) <= s.durationSec * 5));

  if (c.language && c.language !== 'English') {
    const narr = scenes.map((s) => s.narration).join(' ') + ' ' + plan.hook + ' ' + plan.title;
    // Narration is in the native language (non-ASCII diacritics present)...
    add(`narration is written in ${c.language}`, NON_ASCII.test(narr));
    // ...but stock queries must stay ASCII English so Pexels/Pixabay return hits.
    add('queries stay in English (ASCII)', scenes.every((s) => ASCII_ONLY.test(s.query || '')));
  }

  if (c.context === 'africa') {
    const blob = JSON.stringify(plan).toLowerCase();
    const africaHints = ['africa', 'nigeria', 'kenya', 'rural', 'market', 'mobile', 'money', 'community', 'east', 'ibadan', 'yoruba', 'lagos'];
    add('africa context surfaces relevant references', africaHints.some((h) => blob.includes(h)));
  }

  return checks;
}

async function main() {
  if (!config.xaiKey) {
    console.error('SKIP: XAI_API_KEY not set — eval requires the real model.');
    process.exit(2);
  }

  let pass = 0, total = 0;
  for (const c of CASES) {
    const langLabel = c.language && c.language !== 'English' ? ` [${c.language}]` : '';
    console.log(`\n▶ ${c.context}/${c.tone}/${c.targetSeconds}s${langLabel} — "${c.topic}"`);
    let plan;
    try {
      plan = await generateVideoPlan(c);
    } catch (e) {
      console.error(`  ✗ generation failed: ${e.message}`);
      total += 1; // count as a hard fail
      continue;
    }
    console.log(`  plan: "${plan.title}" — ${plan.scenes.length} scenes`);
    for (const r of checkPlan(plan, c)) {
      total += 1;
      if (r.ok) pass += 1;
      console.log(`    ${r.ok ? '✓' : '✗'} ${r.name}`);
    }
  }

  const score = total ? pass / total : 0;
  console.log(`\nSCORE: ${pass}/${total} = ${(score * 100).toFixed(1)}%  (threshold ${(PASS_THRESHOLD * 100)}%)`);
  if (score < PASS_THRESHOLD) {
    console.error('EVAL FAILED: plan quality below threshold.');
    process.exit(1);
  }
  console.log('EVAL PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
