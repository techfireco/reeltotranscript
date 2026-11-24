import { chunksToSRT, chunksToVTT, formatVTTTimestamp } from './subtitles';

type Result = { text: string; chunks: { timestamp: [number, number]; text: string }[] };
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
let retryKey = '';
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

async function watch(job: string) {
  sessionStorage.setItem('pending-transcription', job);
  notice.textContent = 'Transcribing. You can refresh this page to check progress.';
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
    byId('transcript-text').textContent = output.text;
    byId('segments').replaceChildren(...output.chunks.map(chunk => {
      const row = document.createElement('li');
      row.textContent = formatVTTTimestamp(chunk.timestamp[0]).slice(3, 8) + '  ' + chunk.text;
      return row;
    }));
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
  const upload = new FormData(form).get('source') === 'file';
  byId('file-panel').hidden = file.disabled = !upload;
  byId('link-panel').hidden = link.disabled = upload;
  file.required = upload;
  link.required = !upload;
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
  fieldset.disabled = true;
  update();
  byId('result').hidden = true;
  output = null;
  notice.textContent = 'Submitting your clip…';
  try {
    const pending = sessionStorage.getItem('pending-transcription');
    if (pending) { await watch(pending); return; }
    retryKey ||= crypto.randomUUID();
    const data = await api('/api/transcriptions', {
      method: 'POST', headers: { 'Content-Type': upload ? 'application/octet-stream' : 'application/json',
        'X-Challenge-Token': token, 'Idempotency-Key': retryKey },
      body: upload ? file.files![0] : JSON.stringify({ url: link.value.trim() }),
    });
    await watch(data.id);
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
byId('copy').addEventListener('click', async () => {
  if (!output) return;
  try { await navigator.clipboard.writeText(output.text); byId('export-notice').textContent = 'Transcript copied.'; }
  catch { byId('export-notice').textContent = 'Copy unavailable. Select the transcript text to copy it.'; }
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
