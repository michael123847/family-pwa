/**
 * ai.js — Local AI chat via Ollama (Qwen 2.5 7B).
 *
 * The PWA sends the conversation history to the local Express server
 * (/api/ai/chat), which proxies it to the Ollama API running on the same
 * machine. Ollama streams the response as NDJSON; this module reads it
 * token by token so the answer appears as it is generated.
 *
 * Conversation history is persisted in localStorage so it survives page
 * reloads. The user can clear it at any time with the "Gespräch löschen"
 * button.
 *
 * The AI is only available on the home network (server reachability check).
 */

import { CONFIG } from '../config.js';
import { isLocalAvailable, authHeaders } from '../localBridge.js';

const AI_URL     = CONFIG.LOCAL_BASE + CONFIG.LOCAL_AI_PATH;
const CACHE_KEY  = 'pwa.ai.history';

// System prompt sent at the start of every request (not stored in history).
const SYSTEM = {
  role:    'system',
  content: 'Du bist ein hilfreicher Familienassistent. Antworte kurz und klar. ' +
           'Schreibe in der Sprache, in der der Nutzer schreibt.',
};

// In-memory conversation (user + assistant turns only, no system message).
let history  = [];
let thinking = false; // true while waiting for the first token

// ── Persistence ───────────────────────────────────────────────────────────────

function saveHistory() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(history)); } catch {}
}

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '[]'); } catch { return []; }
}

// ── Render ────────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Converts plain text to safe HTML — preserves newlines and code blocks. */
function fmt(s) {
  return esc(s).replace(/\n/g, '<br>');
}

function render() {
  const list = document.getElementById('ai-messages');
  if (!list) return;

  if (!history.length && !thinking) {
    list.innerHTML = '<div class="ai-empty">Stell mir eine Frage — ich bin nur im Heim-WLAN verfügbar.</div>';
    return;
  }

  list.innerHTML = history.map(m => `
    <div class="ai-msg ai-msg-${m.role}">
      <div class="ai-bubble">${m.content ? fmt(m.content) : '<span class="ai-cursor">▍</span>'}</div>
    </div>`).join('') +
    (thinking
      ? '<div class="ai-msg ai-msg-assistant"><div class="ai-bubble"><span class="ai-cursor">▍</span></div></div>'
      : '');

  list.scrollTop = list.scrollHeight;
}

function setOffline(offline) {
  document.getElementById('ai-offline')?.classList.toggle('visible', offline);
}

// ── Send ──────────────────────────────────────────────────────────────────────

async function send(text) {
  text = text.trim();
  if (!text || thinking) return;

  if (!(await isLocalAvailable())) { setOffline(true); return; }
  setOffline(false);

  history.push({ role: 'user', content: text });
  thinking = true;
  render();

  // Placeholder for the AI reply — updated token by token during streaming.
  const aiMsg = { role: 'assistant', content: '' };

  try {
    const r = await fetch(AI_URL, {
      method:      'POST',
      credentials: 'omit',
      headers:     { 'Content-Type': 'application/json', ...authHeaders() },
      body:        JSON.stringify({ messages: [SYSTEM, ...history] }),
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: 'HTTP ' + r.status }));
      throw new Error(err.error ?? 'HTTP ' + r.status);
    }

    // First byte received → replace the "thinking" spinner with the reply bubble.
    thinking = false;
    history.push(aiMsg);

    const reader  = r.body.getReader();
    const decoder = new TextDecoder();
    let   buf     = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });

      // Ollama sends one JSON object per line.
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.message?.content) {
            aiMsg.content += obj.message.content;
            render();
          }
        } catch { /* skip malformed line */ }
      }
    }

    if (!aiMsg.content) throw new Error('Keine Antwort erhalten.');

  } catch (e) {
    thinking = false;
    if (!history.includes(aiMsg)) history.push(aiMsg);
    aiMsg.content = '⚠️ ' + e.message;
    render();
  }

  render();
  saveHistory();
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initAi() {
  history = loadHistory();

  const input = document.getElementById('ai-input');

  document.getElementById('ai-send').addEventListener('click', () => {
    const t = input.value; input.value = ''; send(t);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const t = input.value; input.value = ''; send(t);
    }
  });

  document.getElementById('ai-clear').addEventListener('click', () => {
    if (thinking) return;
    history = []; saveHistory(); render();
  });

  // Refresh server status every time the user opens this subpage.
  window.addEventListener('pwa:page', async e => {
    if (e.detail !== 'ai') return;
    const online = await isLocalAvailable();
    setOffline(!online);
    render();
    if (online) input.focus();
  });

  render();
}
