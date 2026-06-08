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
const MODEL_KEY        = 'pwa.ai.model';
const MODELS_CACHE_KEY = 'pwa.ai.models'; // cached model-name list (survives navigation)
const PENDING_JOB_KEY  = 'pwa.ai.pending'; // { jobId, model, ts } — survives app reload

// No system prompt. An earlier German prompt biased the model toward German
// replies on short/ambiguous input (e.g. "?"); with no instructions the model
// simply mirrors whatever language the user writes. Kept as an empty-content
// object so the request-building code is unchanged — the server drops
// empty-content messages, so nothing is actually sent.
const SYSTEM = {
  role:    'system',
  content: '',
};

// In-memory conversation (user + assistant turns only, no system message).
let history       = [];
let thinking      = false; // true while waiting for the first token
let generating    = false; // true for the whole send() lifecycle (drives the Stop button)
let currentJobId  = null;  // the server job currently streaming (for cancel)
let selectedModel = localStorage.getItem(MODEL_KEY) ?? ''; // chosen Ollama model
let lastError     = ''; // transient — shown until next successful response or user action

// Monotonic counter: each call to send() captures the current value; if the
// counter advances mid-stream (because the user hit "Gespräch löschen" or
// switched models), the in-flight send() exits silently and stops mutating
// history. Without this, "clear" was ignored while AI was generating.
let sendGen  = 0;
let wakeLock = null; // screen Wake Lock; module-scope so visibility handler can re-acquire

// ── Persistence ───────────────────────────────────────────────────────────────

function saveHistory() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(history)); } catch {}
}

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '[]'); } catch { return []; }
}

function savePendingJob(jobId, model) {
  try { localStorage.setItem(PENDING_JOB_KEY, JSON.stringify({ jobId, model, ts: Date.now() })); } catch {}
}
function clearPendingJob() {
  try { localStorage.removeItem(PENDING_JOB_KEY); } catch {}
}

// ── Render ────────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Renders the Markdown an LLM emits as safe HTML. esc() runs first, so every
// rule below operates on escaped text - no injection is possible. Handles
// fenced + inline code, bold, italic, headings, and bullet/numbered lists;
// any other text keeps its line breaks.
function fmt(s) {
  let h = esc(s);

  // Protect code from the inline rules by stashing it behind placeholders.
  const stash = [];
  const keep  = html => '<!--c' + (stash.push(html) - 1) + '-->';
  h = h.replace(/```(?:[a-z0-9]*\n)?([\s\S]*?)```/gi, (_, c) => keep('<pre class="ai-code">' + c.replace(/\n$/, '') + '</pre>'));
  h = h.replace(/`([^`\n]+)`/g, (_, c) => keep('<code>' + c + '</code>'));

  // Bold before italic so ** isn't consumed by the single-* rule.
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/__([^_\n]+)__/g,     '<strong>$1</strong>');
  h = h.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  h = h.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');

  // Line-based: headings + bullet/numbered lists, otherwise join with <br>.
  let out = '', list = null;
  const closeList = () => { if (list) { out += `</${list}>`; list = null; } };
  for (const line of h.split('\n')) {
    let m;
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (list !== 'ul') { closeList(); out += '<ul>'; list = 'ul'; }
      out += '<li>' + m[1] + '</li>';
    } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      if (list !== 'ol') { closeList(); out += '<ol>'; list = 'ol'; }
      out += '<li>' + m[1] + '</li>';
    } else if ((m = line.match(/^\s*#{1,3}\s+(.*)$/))) {
      closeList(); out += '<strong class="ai-h">' + m[1] + '</strong><br>';
    } else {
      closeList(); out += line + '<br>';
    }
  }
  closeList();
  out = out.replace(/(<br>)+$/, '');

  // Restore the stashed code (which must not get <br>-wrapped internally).
  return out.replace(/<!--c(\d+)-->/g, (_, i) => stash[+i]);
}

/**
 * Splits an assistant response into segments by quoted spans. Quoted spans
 * are rendered in their own bubble with a copy button — useful when the AI
 * drafts an email or message body for the user to paste elsewhere.
 *
 * Recognises both ASCII (`"…"`) and German (`„…"`) quotes. Only quoted spans
 * of meaningful length (≥ 40 chars OR containing a newline) are split out —
 * short inline quotes stay in the prose bubble where they belong.
 *
 * Returns an array of `{ quoted: bool, text: string }` segments preserving
 * the original order.
 */
function splitQuotes(text) {
  const MIN_QUOTE_LEN = 40;
  const segments      = [];
  // Match either "…" or „…" — non-greedy body.
  const re = /(?:"([^"]+?)"|„([^"]+?)")/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const inside = m[1] ?? m[2];
    // Skip trivially short inline quotes — keep them inline.
    if (inside.length < MIN_QUOTE_LEN && !inside.includes('\n')) continue;
    if (m.index > last) {
      segments.push({ quoted: false, text: text.slice(last, m.index) });
    }
    segments.push({ quoted: true, text: inside });
    last = re.lastIndex;
  }
  if (last < text.length) segments.push({ quoted: false, text: text.slice(last) });
  if (!segments.length)   segments.push({ quoted: false, text });
  // Strip empty / whitespace-only segments that result from edge cases.
  return segments.filter(s => s.text && s.text.trim());
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
    // Assistant — split think out into its own italic bubble if present,
    // then split the remaining response by quoted spans so long quotes
    // (email drafts etc.) become their own copy-able bubble.
    const { think, response } = splitThink(m.content);
    let html = '';
    if (think) {
      html += `<div class="ai-msg ai-msg-assistant ai-msg-think">
                 <div class="ai-bubble">${fmt(think)}</div>
               </div>`;
    }
    if (response) {
      const segments = splitQuotes(response);
      segments.forEach((seg, segIdx) => {
        const cls       = seg.quoted ? 'ai-msg-assistant ai-msg-quote' : 'ai-msg-assistant';
        // Each quoted segment gets its own copy button targeting just that span.
        const copyBtn   = seg.quoted
          ? `<button class="ai-copy-btn" data-idx="${i}" data-seg="${segIdx}" title="Zitat kopieren">⎘</button>`
          // Non-quoted segments — only emit a copy button on the LAST one,
          // and have it copy the full response (without quotes / think).
          : (segIdx === segments.length - 1
              ? `<button class="ai-copy-btn" data-idx="${i}" title="Antwort kopieren">⎘</button>`
              : '');
        html += `<div class="ai-msg ${cls}">
                   <div class="ai-bubble">${fmt(seg.text)}</div>
                   ${copyBtn}
                 </div>`;
      });
    } else if (!think) {
      // Streaming hasn't started yet — show the cursor.
      html += `<div class="ai-msg ai-msg-assistant">
                 <div class="ai-bubble"><span class="ai-cursor">▍</span></div>
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
      if (!m) return;
      let content;
      if (m.role === 'assistant') {
        const { response } = splitThink(m.content);
        if (btn.dataset.seg !== undefined) {
          // Per-quote copy: just the text of that quoted span.
          const seg = splitQuotes(response)[Number(btn.dataset.seg)];
          content = seg?.text ?? '';
        } else {
          // Default copy: the whole response stripped of think and quote marks.
          content = response;
        }
      } else {
        content = m.content ?? '';
      }
      navigator.clipboard.writeText(content).then(() => {
        btn.textContent = '✓';
        setTimeout(() => btn.textContent = '⎘', 1200);
      });
    });
  });

  list.scrollTop = list.scrollHeight;
  syncSendButton();
}

// Reflects the generating state on the send button: a Stop square while a
// response streams, the send arrow otherwise.
function syncSendButton() {
  const btn = document.getElementById('ai-send');
  if (!btn) return;
  if (generating) { btn.textContent = '■'; btn.title = 'Stopp';  btn.classList.add('ai-stop'); }
  else            { btn.textContent = '→'; btn.title = 'Senden'; btn.classList.remove('ai-stop'); }
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
// Fills the model <option>s and keeps selectedModel valid.
function renderModelOptions(sel, names) {
  if (!names.includes(selectedModel)) selectedModel = names[0];
  sel.innerHTML = names.map(n =>
    `<option value="${esc(n)}"${n === selectedModel ? ' selected' : ''}>${esc(n)}</option>`
  ).join('');
  sel.disabled = false;
}

async function loadModels() {
  const sel = document.getElementById('ai-model');
  if (!sel) return;

  // Restore cached models instantly so the dropdown is never blank on re-entry
  // (it used to go empty when isLocalAvailable() returned a transient false and
  // this function was skipped). The fetch below then refreshes the list.
  const hasReal = !!sel.querySelector('option[value]');
  if (!hasReal) {
    try {
      const cached = JSON.parse(localStorage.getItem(MODELS_CACHE_KEY) || '[]');
      if (cached.length) renderModelOptions(sel, cached);
    } catch { /* no cache */ }
  }

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

    // Smallest first — usually the fastest to load and the common default.
    const sorted = [...models].sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
    const names  = sorted.map(m => m.name);
    localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(names));
    const stored = localStorage.getItem(MODEL_KEY);
    selectedModel = names.includes(stored) ? stored
                  : names.includes(defaultModel) ? defaultModel
                  : names[0];
    localStorage.setItem(MODEL_KEY, selectedModel);
    renderModelOptions(sel, names);
  } catch {
    // Offline / transient failure: keep the options we already show (cached or
    // live). Only fall back to an error label if the dropdown is truly empty.
    if (!sel.querySelector('option[value]')) {
      sel.innerHTML = '<option>Modelle nicht geladen</option>';
      sel.disabled = true;
    }
  }
}

/** Switching the model clears the conversation to avoid mixing styles. */
function onModelChange(newModel) {
  if (!newModel || newModel === selectedModel) return;
  if (generating) abortCurrentJob(); // free Ollama's slot immediately
  selectedModel = newModel;
  localStorage.setItem(MODEL_KEY, newModel);
  generating = false;
  thinking   = false;
  history    = [];
  lastError  = '';
  saveHistory();
  render();
}

// ── Send ──────────────────────────────────────────────────────────────────────

async function send(text) {
  text = text.trim();
  if (!text || generating) return;

  if (!(await isLocalAvailable())) { setOffline(true); return; }
  setOffline(false);

  // Clear any leftover error from a previous failed send.
  lastError = '';

  // Capture this send's generation. If the user clears the chat or switches
  // models, sendGen advances and every check below bails out silently.
  const mySend = ++sendGen;

  history.push({ role: 'user', content: text });
  saveHistory(); // persist question before generation so a reload can restore it
  thinking   = true;
  generating = true;
  render();

  // Hold a screen Wake Lock while the model is generating — large models like
  // qwq:32b take 15-30 s for the first token, easily long enough for auto-lock
  // to drop the connection. Wake Lock prevents the timeout-based screen sleep;
  // a manual power-button press still wins, but auto-lock is the common case.
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
    currentJobId = jobId;
    savePendingJob(jobId, selectedModel);

    // If user cleared / switched between POST and now, abandon this send.
    if (mySend !== sendGen) return;

    // 2. Swap the "thinking" cursor for an empty assistant bubble that
    //    polling will fill in.
    thinking = false;
    history.push(aiMsg);
    saveHistory(); // persist placeholder so resumePendingJob has something to fill
    render();

    // 3. Poll for deltas. The `setTimeout` between polls gets paused while
    //    the JS context is suspended (screen lock); when it resumes, the
    //    next poll fetches everything the server has accumulated meanwhile.
    let cursor       = 0;
    let pollErrors   = 0;
    let pollErrDelay = 500;
    const POLL_MS    = 500;
    const MAX_ERRORS = 30; // ~tens of seconds of tolerance on mobile wake

    for (;;) {
      await new Promise(r => setTimeout(r, POLL_MS));
      // User hit "Gespräch löschen" (or changed model) — abandon the loop
      // and stop appending to aiMsg.
      if (mySend !== sendGen) return;

      let pollR;
      try {
        pollR = await fetch(aiUrl() + '/' + jobId + '?cursor=' + cursor, {
          credentials: 'omit',
          headers:     authHeaders(),
        });
      } catch (e) {
        pollErrors++;
        pollErrDelay = Math.min(pollErrDelay * 1.5, 10_000);
        if (pollErrors >= MAX_ERRORS) throw e;
        await new Promise(r => setTimeout(r, pollErrDelay));
        continue; // transient — try again after backoff
      }
      if (!pollR.ok) throw new Error('HTTP ' + pollR.status);
      const body = await pollR.json();
      pollErrors   = 0;
      pollErrDelay = POLL_MS;
      if (mySend !== sendGen) return;  // re-check after the await
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
    // Don't surface errors from a send that was superseded by a clear.
    if (mySend !== sendGen) return;
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
    generating   = false;
    currentJobId = null;
    clearPendingJob();
    // Always release the wake lock so the screen can sleep normally afterwards.
    try { await wakeLock?.release(); } catch {}
    wakeLock = null;
  }

  render();
  saveHistory();
}

// Cancel the current server job: send DELETE so Ollama frees its slot immediately,
// advance sendGen so any active poll loop bails, and clear the pending-job marker.
// Called by stopGeneration(), the clear handler, and model-switch.
function abortCurrentJob() {
  if (currentJobId) {
    fetch(aiUrl() + '/' + currentJobId, { method: 'DELETE', headers: authHeaders() }).catch(() => {});
  }
  clearPendingJob();
  sendGen++;
  currentJobId = null;
}

// Stop an in-progress generation: abort the server job, bail the poll loop
// (keeping whatever streamed so far), and reset the UI.
function stopGeneration() {
  if (!generating) return;
  abortCurrentJob();
  generating = false;
  thinking   = false;
  // Drop an empty assistant placeholder if nothing had streamed yet.
  const last = history[history.length - 1];
  if (last && last.role === 'assistant' && !last.content) history.pop();
  saveHistory();
  render();
}

// ── Resume ────────────────────────────────────────────────────────────────────

// Re-attach to an in-flight server job after the PWA was reloaded or returned
// from background. Reads the pending-job marker from localStorage, polls from
// cursor 0 (replacing the placeholder content rather than appending — safe even
// if the stored cursor was stale), and honours the same sendGen/mySend guard as
// send(). A 404 means the server restarted and the job is gone — clears silently.
async function resumePendingJob() {
  if (generating) return;                        // synchronous guard — no await before this
  let p;
  try { p = JSON.parse(localStorage.getItem(PENDING_JOB_KEY) || 'null'); } catch {}
  if (!p?.jobId || Date.now() - p.ts > 15 * 60_000) { clearPendingJob(); return; }

  generating   = true;
  const mySend = ++sendGen;
  currentJobId = p.jobId;
  lastError    = '';

  // Ensure a trailing assistant placeholder exists to fill in.
  let aiMsg = history[history.length - 1];
  if (!aiMsg || aiMsg.role !== 'assistant') {
    aiMsg = { role: 'assistant', content: '' };
    history.push(aiMsg);
  }
  aiMsg.content = ''; // rebuilt from cursor 0
  render();

  // Re-acquire wake lock if we're in the foreground.
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch {}

  let cursor       = 0;
  let pollErrors   = 0;
  let pollErrDelay = 500;
  const POLL_MS    = 500;
  const MAX_ERRORS = 30;

  try {
    for (;;) {
      await new Promise(r => setTimeout(r, POLL_MS));
      if (mySend !== sendGen) return;

      let pollR;
      try {
        pollR = await fetch(aiUrl() + '/' + p.jobId + '?cursor=' + cursor, {
          credentials: 'omit',
          headers:     authHeaders(),
        });
      } catch (e) {
        pollErrors++;
        pollErrDelay = Math.min(pollErrDelay * 1.5, 10_000);
        if (pollErrors >= MAX_ERRORS) throw e;
        await new Promise(r => setTimeout(r, pollErrDelay));
        continue;
      }
      if (pollR.status === 404) { clearPendingJob(); return; } // server restarted
      if (!pollR.ok) throw new Error('HTTP ' + pollR.status);

      const body = await pollR.json();
      pollErrors   = 0;
      pollErrDelay = POLL_MS;
      if (mySend !== sendGen) return;

      aiMsg.content += body.delta;
      cursor = body.cursor;
      render();
      if (body.error) throw new Error(body.error);
      if (body.done)  break;
    }

    if (!aiMsg.content) throw new Error('Keine Antwort erhalten.');

  } catch (e) {
    if (mySend !== sendGen) return;
    thinking = false;
    if (history[history.length - 1] === aiMsg && !aiMsg.content) history.pop();
    const msg = e.message || '';
    if (msg === 'Failed to fetch' || /aborted/i.test(msg)) {
      lastError = 'Antwort unterbrochen — bei grossen Modellen den Bildschirm nicht sperren.';
    } else {
      lastError = msg;
    }
  } finally {
    generating   = false;
    currentJobId = null;
    clearPendingJob();
    try { await wakeLock?.release(); } catch {}
    wakeLock = null;
  }

  render();
  saveHistory();
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initAi() {
  history = loadHistory();

  const input = document.getElementById('ai-input');

  document.getElementById('ai-send').addEventListener('click', () => {
    if (generating) { stopGeneration(); return; }
    const t = input.value; input.value = ''; send(t);
  });
  // Enter submits — without this, mobile keyboards do nothing on Enter
  // because there's no surrounding <form> to auto-submit.
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const t = input.value; input.value = ''; send(t);
    }
  });

  document.getElementById('ai-clear').addEventListener('click', () => {
    // Abort any in-flight server job so Ollama frees its slot immediately.
    if (generating) abortCurrentJob();
    generating = false;
    thinking   = false;
    history    = [];
    lastError  = '';
    saveHistory();
    render();
  });

  document.getElementById('ai-model').addEventListener('change', e => {
    if (thinking) { e.target.value = selectedModel; return; }
    onModelChange(e.target.value);
  });

  // Re-acquire the wake lock and re-attach to any pending job when the app
  // returns to the foreground (e.g. user switched apps while waiting for qwen3).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (generating && !wakeLock) {
      navigator.wakeLock?.request('screen').then(l => { wakeLock = l; }).catch(() => {});
    }
    resumePendingJob(); // no-op if generating is already true
  });

  // Refresh server status and model list every time the user opens this subpage.
  window.addEventListener('pwa:page', async e => {
    if (e.detail !== 'ai') return;
    const online = await isLocalAvailable();
    setOffline(!online);
    await loadModels(); // always — it restores from cache + handles offline itself
    render();
    if (online) input.focus();
    resumePendingJob(); // re-attach if an answer was still being computed
  });

  render();
}
