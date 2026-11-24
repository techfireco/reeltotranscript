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

