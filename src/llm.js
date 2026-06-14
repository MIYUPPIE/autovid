import fetch from 'node-fetch';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from './config.js';

const execFileP = promisify(execFile);

// All of Grok's job in AutoVid is plain chat-completions returning JSON. Both
// xAI and OpenRouter are OpenAI-compatible, so they share one client; local
// Claude Code is shelled out. Switch with LLM_PROVIDER in .env.
async function openaiCompatChat({ base, key, model, messages, temperature = 0.7, jsonMode = false, extraHeaders = {} }) {
  const body = { model, messages, temperature, stream: false };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...extraHeaders },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM API error ${res.status} (${model}): ${text}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// Route through a local Claude Code CLI (free, no API key). Honors the global
// "prefer local Claude Code" rule when LLM_PROVIDER=claude-code.
async function claudeCodeChat({ messages, jsonMode = false }) {
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const usr = messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n');
  let prompt = (sys ? `${sys}\n\n` : '') + usr;
  if (jsonMode) prompt += '\n\nRespond with ONLY valid JSON. No markdown, no commentary.';
  try {
    const { stdout } = await execFileP(config.claudeBin, ['-p', '--output-format', 'text', prompt],
      { maxBuffer: 1024 * 1024 * 16 });
    return stdout;
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Claude CLI not found ("${config.claudeBin}"). Set CLAUDE_BIN or pick another LLM_PROVIDER.`);
    }
    throw err;
  }
}

/**
 * Provider-agnostic chat. messages: [{role, content}]. opts: { temperature, jsonMode }.
 */
export async function llmChat(messages, opts = {}) {
  const provider = config.llmProvider;
  if (provider === 'openrouter') {
    if (!config.openrouterKey) throw new Error('OPENROUTER_API_KEY is not set');
    return openaiCompatChat({
      base: config.openrouterBase, key: config.openrouterKey, model: config.openrouterModel,
      messages, ...opts,
      extraHeaders: { 'HTTP-Referer': 'http://localhost:3000', 'X-Title': 'AutoVid' },
    });
  }
  if (provider === 'claude-code') {
    return claudeCodeChat({ messages, ...opts });
  }
  // default: xAI / Grok
  if (!config.xaiKey) throw new Error('XAI_API_KEY is not set');
  return openaiCompatChat({
    base: config.xaiBase, key: config.xaiKey, model: config.xaiModel, messages, ...opts,
  });
}

/**
 * Describe the active provider for /api/health and the UI.
 */
export function activeLlm() {
  const provider = config.llmProvider;
  if (provider === 'openrouter') {
    return { provider, model: config.openrouterModel, configured: Boolean(config.openrouterKey) };
  }
  if (provider === 'claude-code') {
    return { provider, model: config.claudeBin, configured: true };
  }
  return { provider: 'xai', model: config.xaiModel, configured: Boolean(config.xaiKey) };
}
