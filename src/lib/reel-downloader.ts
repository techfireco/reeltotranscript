/**
 * Instagram Reel & Short Video Resolver
 * Powered by your self-hosted Coolify Download Engine (Cobalt + yt-dlp + Stream Proxy)
 * and in-browser local Whisper transcription.
 */

export interface ReelMetadata {
  id: string;
  sourceUrl: string;
  videoUrl: string;
  title: string;
  author: string;
  thumbnailUrl?: string;
  duration?: number;
  videoBlob?: Blob;
}

export interface ResolutionError {
  message: string;
  isRestricted: boolean;
  shortcode?: string;
  sourceUrl: string;
  downloadHelpers: Array<{ name: string; url: string }>;
}

// Self-hosted Coolify Download Engine URLs
export const DEFAULT_COOLIFY_ENGINE = 'https://dl.152.67.25.227.sslip.io';
export const DEFAULT_COBALT_ENGINE = 'https://cobalt.152.67.25.227.sslip.io';

export function getEngineUrl(): string {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('coolify_download_engine_url');
    if (saved && saved.trim().startsWith('http')) {
      return saved.trim().replace(/\/+$/, '');
    }
  }
  return DEFAULT_COOLIFY_ENGINE;
}

export function extractInstagramShortcode(url: string): string | null {
  try {
    const trimmed = url.trim();
    const match = trimmed.match(/(?:instagram\.com\/(?:reel|reels|p|share\/reel)\/)([A-Za-z0-9_-]+)/i);
    if (match && match[1]) {
      return match[1];
    }
  } catch (err) {
    console.error('Error parsing IG shortcode:', err);
  }
  return null;
}

export function isDirectMediaUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  return (
    lower.includes('.mp4') ||
    lower.includes('.webm') ||
    lower.includes('.mov') ||
    lower.includes('.m4a') ||
    lower.includes('cdninstagram.com') ||
    lower.includes('fbcdn.net') ||
    lower.includes('tiktokcdn.com') ||
    lower.includes('googlevideo.com')
  );
}

export function isValidInstagramUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  return Boolean(extractInstagramShortcode(url)) || isDirectMediaUrl(url);
}

/**
 * Resolves media stream via self-hosted Coolify Engine and downloads video buffer locally
 */
export async function resolveReel(
  url: string,
  onProgress?: (msg: string) => void
): Promise<ReelMetadata> {
  const trimmedUrl = url.trim();
  const engineBase = getEngineUrl();

  // Case 0: Direct Media URL (e.g. pasted CDN link or .mp4)
  if (isDirectMediaUrl(trimmedUrl)) {
    onProgress?.('Direct video stream detected. Downloading media buffer...');
    const videoBlob = await fetchWithProgress(trimmedUrl, onProgress);
    return {
      id: 'direct-video',
      sourceUrl: trimmedUrl,
      videoUrl: trimmedUrl,
      title: 'Direct Video Stream',
      author: 'Media Link',
      videoBlob,
    };
  }

  const shortcode = extractInstagramShortcode(trimmedUrl);
  if (!shortcode && !trimmedUrl.includes('tiktok.com') && !trimmedUrl.includes('youtube.com/shorts')) {
    throw new Error('Please enter a valid Instagram Reel, TikTok, or YouTube Shorts link.');
  }

  // Attempt 1: Self-Hosted Coolify Download Engine (POST /api/resolve)
  try {
    onProgress?.('Connecting to your Coolify download engine (152.67.25.227)...');
    const engineRes = await fetch(`${engineBase}/api/resolve`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: trimmedUrl }),
    });

    if (engineRes.ok) {
      const data = await engineRes.json();
      if (data.videoUrl) {
        onProgress?.('Coolify engine resolved video stream. Downloading locally into browser memory...');
        // Download via Coolify stream proxy or direct CDN
        const streamUrl = `${engineBase}/api/stream?url=${encodeURIComponent(data.videoUrl)}`;
        let videoBlob: Blob;
        try {
          videoBlob = await fetchWithProgress(streamUrl, onProgress);
        } catch {
          videoBlob = await fetchWithProgress(data.videoUrl, onProgress);
        }

        return {
          id: shortcode || 'video',
          sourceUrl: trimmedUrl,
          videoUrl: data.videoUrl,
          title: data.title || `Video (${shortcode || 'clip'})`,
          author: data.author || '@creator',
          thumbnailUrl: data.thumbnailUrl,
          videoBlob,
        };
      }
    }
  } catch (coolifyErr) {
    console.warn('Coolify download engine query failed, falling back to Cobalt/local:', coolifyErr);
  }

  // Attempt 2: Self-Hosted Cobalt Engine on Coolify (POST https://cobalt.152.67.25.227.sslip.io/)
  try {
    onProgress?.('Querying self-hosted Cobalt engine on Coolify...');
    const cobaltRes = await fetch(`${DEFAULT_COBALT_ENGINE}/`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: trimmedUrl,
        videoQuality: '720',
      }),
    });

    if (cobaltRes.ok) {
      const cobaltData = await cobaltRes.json();
      const resolvedUrl =
        cobaltData.url || (cobaltData.picker && cobaltData.picker[0]?.url);

      if (resolvedUrl) {
        onProgress?.('Cobalt resolved media. Downloading video locally into browser...');
        const videoBlob = await fetchWithProgress(resolvedUrl, onProgress);
        return {
          id: shortcode || 'video',
          sourceUrl: trimmedUrl,
          videoUrl: resolvedUrl,
          title: cobaltData.filename || `Reel (${shortcode || 'clip'})`,
          author: 'Creator',
          videoBlob,
        };
      }
    }
  } catch (cobaltErr) {
    console.warn('Direct Cobalt query failed:', cobaltErr);
  }

  // Attempt 3: Local Server Endpoint /api/resolve-reel
  try {
    onProgress?.('Checking local server fallback resolver...');
    const res = await fetch(`/api/resolve-reel?url=${encodeURIComponent(trimmedUrl)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.videoUrl) {
        onProgress?.('Downloading video stream for local transcription...');
        const videoBlob = await fetchWithProgress(data.videoUrl, onProgress);
        return {
          id: shortcode || 'video',
          sourceUrl: trimmedUrl,
          videoUrl: data.videoUrl,
          title: data.title || `Video (${shortcode || 'clip'})`,
          author: data.author || '@creator',
          thumbnailUrl: data.thumbnailUrl,
          videoBlob,
        };
      }
    }
  } catch {
    // Fallback
  }

  // Attempt 4: FastDL / VKR open resolver
  try {
    onProgress?.('Querying public Instagram CDN resolver...');
    const fastdlProxy = `https://api.vkrdown.com/web/app/instagram.php?url=${encodeURIComponent(trimmedUrl)}`;
    const fastRes = await fetch(fastdlProxy);
    if (fastRes.ok) {
      const data = await fastRes.json();
      const videoUrl = data?.data?.video || data?.video_url || data?.url;
      if (videoUrl) {
        onProgress?.('Downloading video stream...');
        const videoBlob = await fetchWithProgress(videoUrl, onProgress);
        return {
          id: shortcode || 'video',
          sourceUrl: trimmedUrl,
          videoUrl,
          title: data?.title || `Instagram Reel (${shortcode})`,
          author: data?.author || 'Instagram Creator',
          videoBlob,
        };
      }
    }
  } catch {
    // Continue
  }

  // If all automated anonymous downloading fails due to Instagram's bot protection:
  const resolutionError: ResolutionError = {
    message: 'Instagram has restricted direct automated downloading for this specific link.',
    isRestricted: true,
    shortcode: shortcode || undefined,
    sourceUrl: trimmedUrl,
    downloadHelpers: [
      {
        name: 'SnapInsta (Free 1-Click Saver)',
        url: `https://snapinsta.app/?url=${encodeURIComponent(trimmedUrl)}`,
      },
      {
        name: 'FastDL (Free Reel Saver)',
        url: `https://fastdl.app/en?url=${encodeURIComponent(trimmedUrl)}`,
      },
      {
        name: 'SaveIG (Direct Reel Downloader)',
        url: `https://saveig.app/en?url=${encodeURIComponent(trimmedUrl)}`,
      },
    ],
  };

  const customError = new Error(resolutionError.message) as Error & { details: ResolutionError };
  customError.details = resolutionError;
  throw customError;
}

/**
 * Fetches a video blob via direct fetch or CORS fallback
 */
async function fetchWithProgress(
  url: string,
  onProgress?: (msg: string) => void
): Promise<Blob> {
  try {
    const directRes = await fetch(url);
    if (directRes.ok) {
      return await directRes.blob();
    }
  } catch (err) {
    console.warn('Direct video fetch failed due to CORS, attempting via CORS proxy...');
  }

  // Fallback via Coolify stream proxy
  try {
    const coolifyStream = `${DEFAULT_COOLIFY_ENGINE}/api/stream?url=${encodeURIComponent(url)}`;
    const streamRes = await fetch(coolifyStream);
    if (streamRes.ok) {
      return await streamRes.blob();
    }
  } catch {
    // Continue
  }

  // Fallback via public CORS proxy
  const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(url)}`;
  const proxyRes = await fetch(proxyUrl);
  if (proxyRes.ok) {
    return await proxyRes.blob();
  }

  throw new Error('Unable to download video stream due to network or CORS restrictions.');
}
