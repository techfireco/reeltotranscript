import { chunksToSRT, chunksToVTT, formatVTTTimestamp } from './subtitles';

type Result = {
  text: string;
  chunks: { timestamp: [number, number]; text: string }[];
  language?: string;
  detectedLanguage?: string | null;
};

const LANGUAGE_HINTS: Record<string, string> = {
  auto: 'Automatically detects the spoken language.',
  en: 'Fast transcription optimized for English speech.',
  hi: 'Dedicated Hindi model outputting Devanagari script (हिन्दी).',
  hinglish: 'Powered by Apex Hinglish — transcribes Hindi + English mix in Roman script (e.g. "kal meeting hai"). Takes ~25–60s.',
};

const LANGUAGE_LABELS: Record<string, string> = {
  auto: 'Auto Detect',
  en: 'English',
  hi: 'Hindi (हिन्दी)',
  hinglish: 'Hinglish (Apex)',
};
type Turnstile = {
  render: (el: HTMLElement, options: Record<string, unknown>) => string;
  reset: (id: string) => void;
};
declare global { interface Window { turnstile?: Turnstile } }

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = byId<HTMLFormElement>('transcribe-form');
const link = byId<HTMLInputElement>('clip-link');
const file = byId<HTMLInputElement>('clip-file');
const submit = byId<HTMLButtonElement>('submit');
const notice = byId('notice');
const accountStatus = byId('account-status');
let token = '';
let remaining = 0;
let busy = false;
let widget: string | undefined;
let output: Result | null = null;
let rawTranscript = '';
let activeLanguageLabel = 'Full Speech-to-Text';
let retryKey = '';

type ViewMode = 'text' | 'timestamps' | 'srt';
let currentTab: ViewMode = 'text';

function switchViewTab(mode: ViewMode) {
  currentTab = mode;
  const transcriptEl = byId('transcript-text');
  const segmentsEl = byId('segments');
  const srtEl = byId('srt-preview');

  if (transcriptEl) transcriptEl.classList.toggle('hidden', mode !== 'text');
  if (segmentsEl) segmentsEl.classList.toggle('hidden', mode !== 'timestamps');
  if (srtEl) srtEl.classList.toggle('hidden', mode !== 'srt');

  const tabButtons: Record<ViewMode, HTMLElement | null> = {
    text: byId('view-tab-text'),
    timestamps: byId('view-tab-timestamps'),
    srt: byId('view-tab-srt'),
  };

  for (const [k, btn] of Object.entries(tabButtons)) {
    if (!btn) continue;
    const isActive = k === mode;
    btn.className = `view-tab px-3 py-1.5 rounded-lg transition ${
      isActive
        ? 'bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white shadow-xs font-semibold'
        : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white font-medium'
    }`;
  }
}

const update = () => { submit.disabled = busy || !token || remaining <= 0; };
const quota = () => { accountStatus.textContent = remaining + ' of 3 free transcriptions available. Resets at midnight IST.'; };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function api(path: string, options?: RequestInit) {
  const res = await fetch(path, { ...options, cache: 'no-store', signal: AbortSignal.timeout(65000) });
  if (res.status === 401) {
    sessionStorage.removeItem('pending-transcription');
    byId('login').hidden = false;
    byId('logout').hidden = form.hidden = true;
    accountStatus.textContent = 'Your session has ended.';
  }
  const data = await res.json().catch(() => { throw new Error('Service temporarily unavailable. Please try again.'); });
  if (!res.ok) throw new Error(data.error || 'Request failed. Please try again.');
  return data;
}

function enableChallenge(siteKey: string) {
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.onload = () => {
    widget = window.turnstile?.render(byId('challenge'), {
      sitekey: siteKey, action: 'transcribe', size: matchMedia('(max-width: 380px)').matches ? 'compact' : 'flexible',
      callback: (value: string) => { token = value; update(); },
      'expired-callback': () => { token = ''; update(); },
      'error-callback': () => { token = ''; update(); notice.textContent = 'Verification failed to load. Refresh to try again.'; },
    });
  };
  script.onerror = () => { notice.textContent = 'Could not load verification. Refresh to try again.'; };
  document.head.append(script);
}

async function watch(job: string, language = 'auto') {
  sessionStorage.setItem('pending-transcription', job);
  notice.textContent = language === 'hinglish'
    ? 'Transcribing with Apex Hinglish AI (usually 25–60s). You can refresh this page to check progress.'
    : 'Transcribing. You can refresh this page to check progress.';
  for (let attempt = 0; attempt < 180; attempt++) {
    const data = await api('/api/transcriptions/' + encodeURIComponent(job)).catch(err => {
      if (['This transcript has expired.', 'Resource unavailable.'].includes(err.message)) sessionStorage.removeItem('pending-transcription');
      throw err;
    });
    if (data.state === 'running') { await pause(2000); continue; }
    sessionStorage.removeItem('pending-transcription');
    retryKey = '';
    remaining = data.remaining;
    quota();
    if (data.state !== 'done') throw new Error(data.error);
    output = data as Result;
    rawTranscript = output.text;
    const langKey = output.language || 'auto';
    const baseLabel = LANGUAGE_LABELS[langKey] || langKey;
    const detected = langKey === 'auto' && output.detectedLanguage ? ` · Detected: ${output.detectedLanguage.toUpperCase()}` : '';
    activeLanguageLabel = `Full Speech-to-Text · ${baseLabel}${detected}`;
    byId('transcript-text').textContent = output.text;
    byId('view-mode-indicator').textContent = activeLanguageLabel;
    byId('ai-reset-btn')?.classList.add('hidden');

    byId('segments').replaceChildren(...output.chunks.map(chunk => {
      const row = document.createElement('li');
      row.className = 'flex items-start gap-2.5 p-2 rounded-xl hover:bg-neutral-100 dark:hover:bg-neutral-800/60 transition';
      const badge = document.createElement('span');
      badge.className = 'font-mono text-xs font-semibold px-2 py-0.5 rounded bg-[#0066cc]/10 dark:bg-[#2997ff]/15 text-[#0066cc] dark:text-[#2997ff] flex-shrink-0';
      badge.textContent = formatVTTTimestamp(chunk.timestamp[0]).slice(3, 8);
      const text = document.createElement('span');
      text.className = 'text-neutral-800 dark:text-neutral-200';
      text.textContent = chunk.text;
      row.append(badge, text);
      return row;
    }));

    const srtEl = byId('srt-preview');
    if (srtEl) srtEl.textContent = chunksToSRT(output.chunks);

    switchViewTab('text');
    byId('result').hidden = false;
    byId('export-notice').textContent = '';
    notice.textContent = 'Transcription complete.';
    return;
  }
  throw new Error('Refresh to check the status of your transcription.');
}

async function init() {
  const state = await api('/api/session');
  if (!state.available) { accountStatus.textContent = 'Transcription is temporarily unavailable.'; return; }
  if (!state.signedIn) {
    accountStatus.textContent = 'Sign in for three free transcriptions per day.';
    byId('login').hidden = false;
    if (new URLSearchParams(location.search).has('signin')) notice.textContent = 'Sign-in could not be completed. Please try again.';
    return;
  }
  remaining = state.remaining;
  quota();
  form.hidden = byId('logout').hidden = false;
  enableChallenge(state.siteKey);
  const pending = sessionStorage.getItem('pending-transcription');
  if (pending) {
    busy = true;
    try { await watch(pending); } finally { busy = false; update(); }
  }
}
init().catch(err => { notice.textContent = err.message; if (accountStatus.textContent === 'Checking sign-in…') accountStatus.textContent = 'Unable to connect.'; });

form.addEventListener('input', () => { retryKey = ''; });
form.addEventListener('change', () => {
  retryKey = '';
  const data = new FormData(form);
  const upload = data.get('source') === 'file';
  byId('file-panel').hidden = file.disabled = !upload;
  byId('link-panel').hidden = link.disabled = upload;
  file.required = upload;
  link.required = !upload;
  const lang = String(data.get('language') || 'auto');
  const hintEl = document.getElementById('language-hint');
  if (hintEl) hintEl.textContent = LANGUAGE_HINTS[lang] || LANGUAGE_HINTS.auto;
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !token) return;
  if (!file.disabled && (!file.files?.[0] || file.files[0].size > 25 * 1024 * 1024)) {
    notice.textContent = 'Choose a file of up to 25 MiB.'; return;
  }
  busy = true;
  const fieldset = form.querySelector('fieldset')!;
  const upload = !file.disabled;
  const language = String(new FormData(form).get('language') || 'auto');
  fieldset.disabled = true;
  update();
  byId('result').hidden = true;
  output = null;
  notice.textContent = 'Submitting your clip…';
  try {
    const pending = sessionStorage.getItem('pending-transcription');
    if (pending) { await watch(pending, language); return; }
    retryKey ||= crypto.randomUUID();
    const data = await api('/api/transcriptions?language=' + encodeURIComponent(language), {
      method: 'POST', headers: { 'Content-Type': upload ? 'application/octet-stream' : 'application/json',
        'X-Challenge-Token': token, 'Idempotency-Key': retryKey },
      body: upload ? file.files![0] : JSON.stringify({ url: link.value.trim(), language }),
    });
    await watch(data.id, language);
  } catch (err) {
    notice.textContent = err instanceof Error ? err.message : 'Unable to complete transcription.';
  } finally {
    busy = false; token = ''; fieldset.disabled = false;
    if (widget !== undefined) window.turnstile?.reset(widget);
    update();
  }
});
byId('logout').addEventListener('click', async () => {
  try { await api('/auth/logout', { method: 'POST' }); sessionStorage.removeItem('pending-transcription'); location.replace('/'); }
  catch (err) { notice.textContent = (err as Error).message; }
});
// Segmented View Tabs
byId('view-tab-text')?.addEventListener('click', () => switchViewTab('text'));
byId('view-tab-timestamps')?.addEventListener('click', () => switchViewTab('timestamps'));
byId('view-tab-srt')?.addEventListener('click', () => switchViewTab('srt'));

// AI Smart Tools
byId('ai-summary-btn')?.addEventListener('click', () => {
  if (!output || !rawTranscript) return;
  const sentences = rawTranscript
    .split(/(?<=[.?!\u0964])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 5);
  const bullets = sentences.slice(0, 5).map(s => `• ${s}`).join('\n');
  byId('transcript-text').textContent = `=== 📋 KEY TAKEAWAYS & SUMMARY ===\n\n${bullets || rawTranscript}\n\n💡 Summary generated from reel transcript.`;
  byId('view-mode-indicator').textContent = 'Viewing: Key Takeaways & Summary';
  byId('ai-reset-btn')?.classList.remove('hidden');
  switchViewTab('text');
});

byId('ai-caption-btn')?.addEventListener('click', () => {
  if (!output || !rawTranscript) return;
  const hook = rawTranscript.slice(0, 120).trim();
  const caption = `🔥 "${hook}..."\n\nWatch the full video above! What are your thoughts on this? Drop a comment below 👇\n\n#reels #viral #video #shorts #trending #audio #transcript #contentcreator`;
  byId('transcript-text').textContent = caption;
  byId('view-mode-indicator').textContent = 'Viewing: Instagram Caption & Tags';
  byId('ai-reset-btn')?.classList.remove('hidden');
  switchViewTab('text');
});

byId('ai-clean-btn')?.addEventListener('click', () => {
  if (!output || !rawTranscript) return;
  const cleaned = rawTranscript
    .replace(/\b(um|uh|like|you know|sort of|kind of|basically|actually)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  byId('transcript-text').textContent = cleaned;
  byId('view-mode-indicator').textContent = 'Viewing: Cleaned Transcript (Filler Words Removed)';
  byId('ai-reset-btn')?.classList.remove('hidden');
  switchViewTab('text');
});

byId('ai-reset-btn')?.addEventListener('click', () => {
  if (!output || !rawTranscript) return;
  byId('transcript-text').textContent = rawTranscript;
  byId('view-mode-indicator').textContent = activeLanguageLabel;
  byId('ai-reset-btn')?.classList.add('hidden');
  switchViewTab('text');
});

// Copy & Export
byId('copy')?.addEventListener('click', async () => {
  if (!output) return;
  let textToCopy = byId('transcript-text')?.textContent || '';
  if (currentTab === 'timestamps') {
    textToCopy = output.chunks.map(c => `[${formatVTTTimestamp(c.timestamp[0]).slice(3, 8)}] ${c.text}`).join('\n');
  } else if (currentTab === 'srt') {
    textToCopy = chunksToSRT(output.chunks);
  }
  try {
    await navigator.clipboard.writeText(textToCopy);
    byId('export-notice').textContent = 'Copied to clipboard.';
  } catch {
    byId('export-notice').textContent = 'Copy unavailable. Select text to copy.';
  }
});

document.querySelectorAll<HTMLButtonElement>('[data-format]').forEach(button => button.onclick = () => {
  if (!output) return;
  const format = button.dataset.format!;
  const content = format === 'SRT' ? chunksToSRT(output.chunks) : format === 'VTT' ? chunksToVTT(output.chunks) : output.text;
  const url = URL.createObjectURL(new Blob([content], { type: format === 'VTT' ? 'text/vtt' : 'text/plain' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = 'transcript.' + format.toLowerCase(); anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  byId('export-notice').textContent = format + ' export started.';
});
