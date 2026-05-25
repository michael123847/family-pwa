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
import { isLocalAvailable, authHeaders, getActiveBase } from '../localBridge.js';

// Computed lazily — see localBridge.getActiveBase() / probeBase().
const aiUrl       = () => getActiveBase() + CONFIG.LOCAL_AI_PATH;
const aiModelsUrl = () => getActiveBase() + CONFIG.LOCAL_AI_MODELS_PATH;
const CACHE_KEY     = 'pwa.ai.history';
const MODEL_KEY     = 'pwa.ai.model';

// System prompt sent at the start of every request (not stored in history).
const SYSTEM = {
  role:    'system',
  content: 'Du bist ein hilfreicher Familienassistent. Antworte kurz und klar. ' +
           'Schreibe in der Sprache, in der der Nutzer schreibt.',
};

// In-memory conversation (user + assistant turns only, no system message).
let history       = [];
let thinking      = false; // true while waiting for the first token
let selectedModel = localStorage.getItem(MODEL_KEY) ?? ''; // chosen Ollama model
let lastError     = ''; // transient — shown until next successful response or user action

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

/**
 * Reasoning models (qwq, deepseek-r1, etc.) prefix their reply with a
 * <think>…</think> block containing the chain-of-thought. We render the
 * thinking in its own italic bubble before the actual reply.
 *
 * Handles the partial-tag state too:
 *   - "<think>partial..."      → think = "partial...", response = ""
 *   - "<think>full</think>x"   → think = "full", response = "x"
 *   - "plain"                  → think = "", response = "plain"
 */
function splitThink(content) {
  const openIdx = content.indexOf('<think>');
  if (openIdx === -1) return { think: '', response: content };

  const afterOpen = content.slice(openIdx + '<think>'.length);
  const closeIdx  = afterOpen.indexOf('</think>');
  if (closeIdx === -1) {
    // Open tag seen, close not yet — show what we have as think, no main bubble yet.
    return { think: afterOpen, response: '' };
  }
  return {
    think:    afterOpen.slice(0, closeIdx),
    response: afterOpen.slice(closeIdx + '</think>'.length).replace(/^\s+/, ''),
  };
}

function render() {
  const list = document.getElementById('ai-messages');
  if (!list) return;

  if (!history.length && !thinking && !lastError) {
    list.innerHTML = '<div class="ai-empty">Stell mir eine Frage — ich bin nur im Heim-WLAN verfügbar.</div>';
    return;
  }

  const historyHtml = history.map((m, i) => {
    if (m.role === 'user') {
      return `<div class="ai-msg ai-msg-user">
                <div class="ai-bubble">${m.content ? fmt(m.content) : '<span class="ai-cursor">▍</span>'}</div>
                ${m.content ? `<button class="ai-copy-btn" data-idx="${i}" title="Kopieren">⎘</button>` : ''}
              </div>`;
    }
    // Assistant — split think out into its own italic bubble if present.
    const { think, response } = splitThink(m.content);
    let html = '';
    if (think) {
      html += `<div class="ai-msg ai-msg-assistant ai-msg-think">
                 <div class="ai-bubble">${fmt(think)}</div>
               </div>`;
    }
    // Show main bubble only when there's something to put in it — either an
    // actual response, or no think tag at all (so the user sees the cursor).
    if (response || !think) {
      html += `<div class="ai-msg ai-msg-assistant">
                 <div class="ai-bubble">${response ? fmt(response) : '<span class="ai-cursor">▍</span>'}</div>
                 ${response ? `<button class="ai-copy-btn" data-idx="${i}" title="Kopieren">⎘</button>` : ''}
               </div>`;
    }
    return html;
  }).join('');

  const thinkingHtml = thinking
    ? '<div class="ai-msg ai-msg-assistant"><div class="ai-bubble"><span class="ai-cursor">▍</span></div></div>'
    : '';

  // Errors are transient — not stored in history, so they vanish on next
  // successful send or when the user clears the conversation.
  const errorHtml = lastError
    ? `<div class="ai-error">⚠️ ${esc(lastError)}</div>`
    : '';

  list.innerHTML = historyHtml + thinkingHtml + errorHtml;

  list.querySelectorAll('.ai-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = history[Number(btn.dataset.idx)];
      // For assistant replies, strip the <think>…</think> block so pasting
      // into an email gives only the final answer.
      const content = m?.role === 'assistant'
        ? splitThink(m.content).response
        : (m?.content ?? '');
      navigator.clipboard.writeText(content).then(() => {
        btn.textContent = '✓';
        setTimeout(() => btn.textContent = '⎘', 1200);
      });
    });
  });

  list.scrollTop = list.scrollHeight;
}

function setOffline(offline) {
  document.getElementById('ai-offline')?.classList.toggle('visible', offline);
}

// ── Model dropdown ────────────────────────────────────────────────────────────

/**
 * Fetches the list of installed Ollama models from the local server and
 * populates the dropdown. Restores the previously chosen model from
 * localStorage if it is still installed; otherwise falls back to the
 * server's default model.
 */
async function loadModels() {
  const sel = document.getElementById('ai-model');
  if (!sel) return;

  try {
    const r = await fetch(aiModelsUrl(), {
      cache:       'no-store',
      credentials: 'omit',
      headers:     authHeaders(),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const { models = [], default: defaultModel = '' } = await r.json();

    if (!models.length) {
      sel.innerHTML = '<option>kein Modell installiert</option>';
      sel.disabled = true;
      selectedModel = '';
      return;
    }

    // Smallest first — small models are usually the fastest to load and the
    // most common default choice.
    const sorted = [...models].sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
    const names  = sorted.map(m => m.name);
    const stored = localStorage.getItem(MODEL_KEY);
    selectedModel = names.includes(stored) ? stored
                  : names.includes(defaultModel) ? defaultModel
                  : names[0];
    localStorage.setItem(MODEL_KEY, selectedModel);

    sel.innerHTML = names.map(n =>
      `<option value="${esc(n)}"${n === selectedModel ? ' selected' : ''}>${esc(n)}</option>`
    ).join('');
    sel.disabled = false;
  } catch {
    sel.innerHTML = '<option>Modelle nicht geladen</option>';
    sel.disabled = true;
  }
}

/** Switching the model clears the conversation to avoid mixing styles. */
function onModelChange(newModel) {
  if (!newModel || newModel === selectedModel) return;
  selectedModel = newModel;
  localStorage.setItem(MODEL_KEY, newModel);
  history   = [];
  lastError = '';
  saveHistory();
  render();
}

// ── Send ──────────────────────────────────────────────────────────────────────

async function send(text) {
  text = text.trim();
  if (!text || thinking) return;

  if (!(await isLocalAvailable())) { setOffline(true); return; }
  setOffline(false);

  // Clear any leftover error from a previous failed send.
  lastError = '';

  history.push({ role: 'user', content: text });
  thinking = true;
  render();

  // Hold a screen Wake Lock while the model is generating — large models like
  // qwq:32b take 15-30 s for the first token, easily long enough for auto-lock
  // to drop the connection. Wake Lock prevents the timeout-based screen sleep;
  // a manual power-button press still wins, but auto-lock is the common case.
  let wakeLock = null;
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch { /* lock denied — proceed anyway */ }

  // Placeholder for the AI reply — updated token by token during streaming.
  const aiMsg = { role: 'assistant', content: '' };

  try {
    // 1. Create the job — server starts Ollama in the background regardless
    //    of whether we stay connected. Phone can lock/unlock freely.
    const r = await fetch(aiUrl(), {
      method:      'POST',
      credentials: 'omit',
      headers:     { 'Content-Type': 'application/json', ...authHeaders() },
      body:        JSON.stringify({
        messages: [SYSTEM, ...history],
        model:    selectedModel,
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: 'HTTP ' + r.status }));
      throw new Error(err.error ?? 'HTTP ' + r.status);
    }
    const { jobId } = await r.json();

    // 2. Swap the "thinking" cursor for an empty assistant bubble that
    //    polling will fill in.
    thinking = false;
    history.push(aiMsg);
    render();

    // 3. Poll for deltas. The `setTimeout` between polls gets paused while
    //    the JS context is suspended (screen lock); when it resumes, the
    //    next poll fetches everything the server has accumulated meanwhile.
    let cursor       = 0;
    let pollErrors   = 0;
    const POLL_MS    = 500;
    const MAX_ERRORS = 8; // ~4s of consecutive failures before giving up

    for (;;) {
      await new Promise(r => setTimeout(r, POLL_MS));
      let pollR;
      try {
        pollR = await fetch(aiUrl() + '/' + jobId + '?cursor=' + cursor, {
          credentials: 'omit',
          headers:     authHeaders(),
        });
      } catch (e) {
        pollErrors++;
        if (pollErrors >= MAX_ERRORS) throw e;
        continue; // transient — try again
      }
      if (!pollR.ok) throw new Error('HTTP ' + pollR.status);
      const body = await pollR.json();
      pollErrors = 0;
      if (body.delta) {
        aiMsg.content += body.delta;
        render();
      }
      cursor = body.cursor;
      if (body.error) throw new Error(body.error);
      if (body.done)  break;
    }

    if (!aiMsg.content) throw new Error('Keine Antwort erhalten.');

  } catch (e) {
    thinking = false;
    // Drop the empty placeholder if streaming never started — it would
    // render as an empty bubble. Surface the error as transient UI instead.
    if (history[history.length - 1] === aiMsg && !aiMsg.content) history.pop();
    // Friendlier messages for the two most common failure modes on phones:
    // - generic "Failed to fetch" usually = screen locked / OS suspended JS
    // - explicit "aborted" = user navigated away mid-stream
    const msg = e.message || '';
    if (msg === 'Failed to fetch' || /aborted/i.test(msg)) {
      lastError = 'Antwort unterbrochen — bei grossen Modellen den Bildschirm nicht sperren, '
                + 'bis die Antwort zu erscheinen beginnt.';
    } else {
      lastError = msg;
    }
  } finally {
    // Always release the wake lock so the screen can sleep normally afterwards.
    try { await wakeLock?.release(); } catch {}
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

  document.getElementById('ai-clear').addEventListener('click', () => {
    if (thinking) return;
    history = []; lastError = ''; saveHistory(); render();
  });

  document.getElementById('ai-model').addEventListener('change', e => {
    if (thinking) { e.target.value = selectedModel; return; }
    onModelChange(e.target.value);
  });

  // Refresh server status and model list every time the user opens this subpage.
  window.addEventListener('pwa:page', async e => {
    if (e.detail !== 'ai') return;
    const online = await isLocalAvailable();
    setOffline(!online);
    if (online) await loadModels();
    render();
    if (online) input.focus();
  });

  render();
}
