/**
 * Extracts and resamples audio from any video/audio File or Blob directly in the browser
 * using the native Web Audio API (AudioContext & OfflineAudioContext).
 * Whisper requires mono 16,000 Hz Float32Array PCM.
 */

export interface AudioExtractionResult {
  audioData: Float32Array;
  duration: number;
  sampleRate: number;
  channels: number;
}

export async function extractAudioFromBlob(
  blob: Blob | File,
  targetSampleRate: number = 16000,
  onProgress?: (percent: number, status: string) => void
): Promise<AudioExtractionResult> {
  onProgress?.(10, 'Reading video/audio file buffer...');
  const arrayBuffer = await blob.arrayBuffer();

  onProgress?.(30, 'Decoding audio track with Web Audio API...');
  const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioCtx = new AudioContextClass();

  let decodedAudio: AudioBuffer;
  try {
    decodedAudio = await audioCtx.decodeAudioData(arrayBuffer);
  } catch (err) {
    await audioCtx.close();
    throw new Error('Could not decode audio from the provided file. Ensure it contains a valid audio stream.');
  }

  const duration = decodedAudio.duration;
  const originalSampleRate = decodedAudio.sampleRate;
  onProgress?.(60, `Resampling from ${originalSampleRate}Hz to ${targetSampleRate}Hz mono...`);

  // Use OfflineAudioContext for hardware-accelerated offline resampling
  const totalSamples = Math.ceil(duration * targetSampleRate);
  const offlineCtx = new OfflineAudioContext(1, totalSamples, targetSampleRate);

  // Downmix to mono if multi-channel
  const source = offlineCtx.createBufferSource();
  source.buffer = decodedAudio;
  source.connect(offlineCtx.destination);
  source.start(0);

  const renderedBuffer = await offlineCtx.startRendering();
  await audioCtx.close();

  const channelData = renderedBuffer.getChannelData(0);
  onProgress?.(100, 'Audio extraction complete.');

  return {
    audioData: channelData,
    duration,
    sampleRate: targetSampleRate,
    channels: 1,
  };
}

/**
 * Format timestamp (seconds) into standard SRT format: HH:MM:SS,mmm
 */
export function formatSRTTimestamp(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  const date = new Date(seconds * 1000);
  const hh = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss},${ms}`;
}

/**
 * Format timestamp into standard VTT format: HH:MM:SS.mmm
 */
export function formatVTTTimestamp(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  const date = new Date(seconds * 1000);
  const hh = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

/**
 * Convert transcribed chunks to SRT file string
 */
export function chunksToSRT(chunks: Array<{ timestamp?: [number, number] | null; text: string }>): string {
  return chunks
    .map((chunk, index) => {
      const start = chunk.timestamp?.[0] ?? index * 3;
      const end = chunk.timestamp?.[1] ?? (index + 1) * 3;
      return `${index + 1}\n${formatSRTTimestamp(start)} --> ${formatSRTTimestamp(end)}\n${chunk.text.trim()}\n`;
    })
    .join('\n');
}

/**
 * Convert transcribed chunks to VTT file string
 */
export function chunksToVTT(chunks: Array<{ timestamp?: [number, number] | null; text: string }>): string {
  const body = chunks
    .map((chunk, index) => {
      const start = chunk.timestamp?.[0] ?? index * 3;
      const end = chunk.timestamp?.[1] ?? (index + 1) * 3;
      return `${index + 1}\n${formatVTTTimestamp(start)} --> ${formatVTTTimestamp(end)}\n${chunk.text.trim()}\n`;
    })
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

/**
 * Encodes Float32Array PCM samples into a standard 16-bit PCM WAV Blob
 */
export function pcmToWavBlob(samples: Float32Array, sampleRate: number = 16000): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  // RIFF identifier
  writeString(view, 0, 'RIFF');
  // file length
  view.setUint32(4, 36 + samples.length * 2, true);
  // RIFF type
  writeString(view, 8, 'WAVE');
  // format chunk identifier
  writeString(view, 12, 'fmt ');
  // format chunk length
  view.setUint32(16, 16, true);
  // sample format (1 = PCM)
  view.setUint16(20, 1, true);
  // channel count (1 = mono)
  view.setUint16(22, 1, true);
  // sample rate
  view.setUint32(24, sampleRate, true);
  // byte rate (sampleRate * 1 * 2)
  view.setUint32(28, sampleRate * 2, true);
  // block align (1 * 2)
  view.setUint16(32, 2, true);
  // bits per sample
  view.setUint16(34, 16, true);
  // data chunk identifier
  writeString(view, 36, 'data');
  // data chunk length
  view.setUint32(40, samples.length * 2, true);

  // Write 16-bit PCM samples
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

