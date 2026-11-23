/**
 * Instagram Reel & Short Video Resolver
 * Supports resolving Instagram Reels, TikTok, and direct video links,
 * with fallback CORS proxies and API resolvers.
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

/**
 * Extracts the Instagram shortcode from various Instagram URL formats
 */
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

/**
 * Checks if a URL is a direct media/video stream link
 */
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

/**
 * Validates if the given string is a valid Instagram Reel / Post / Video URL
 */
export function isValidInstagramUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  return Boolean(extractInstagramShortcode(url)) || isDirectMediaUrl(url);
}

/**
 * Resolves an Instagram Reel to a downloadable video URL or video Blob
 */
export async function resolveReel(
  url: string,
  onProgress?: (msg: string) => void
): Promise<ReelMetadata> {
  const trimmedUrl = url.trim();

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

  onProgress?.('Connecting to video resolution engine...');

  // Attempt 1: Internal API endpoint /api/resolve-reel (Node/SSR/yt-dlp/snapsave)
  try {
    const res = await fetch(`/api/resolve-reel?url=${encodeURIComponent(trimmedUrl)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.videoUrl) {
        onProgress?.('Downloading video stream for browser transcription...');
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
  } catch (err) {
    console.warn('Internal API resolver failed, trying public fallback resolvers:', err);
  }

  // Attempt 2: Public FastDL / SnapSave mirror scraper
  try {
    onProgress?.('Trying public Instagram CDN resolvers...');
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
  } catch (err) {
    console.warn('FastDL mirror attempt failed:', err);
  }

  // Attempt 3: Public Cobalt instance pool
  const cobaltInstances = [
    'https://api.cobalt.tools/api/json',
    'https://cobalt.api.kektube.com/api/json',
    'https://co.wuk.sh/api/json',
  ];

  for (const instance of cobaltInstances) {
    try {
      onProgress?.('Querying open media resolver...');
      const cobaltRes = await fetch(instance, {
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
        if (cobaltData.url) {
          onProgress?.('Downloading video stream...');
          const videoBlob = await fetchWithProgress(cobaltData.url, onProgress);
          return {
            id: shortcode || 'video',
            sourceUrl: trimmedUrl,
            videoUrl: cobaltData.url,
            title: cobaltData.filename || `Reel (${shortcode})`,
            author: 'Creator',
            videoBlob,
          };
        }
      }
    } catch {
      // Continue to next mirror
    }
  }

  // Attempt 4: Embed scraper with multi-cors proxies
  if (shortcode) {
    const proxies = [
      (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
      (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    ];

    const embedUrl = `https://www.instagram.com/reel/${shortcode}/embed/captioned/`;
    for (const proxyFn of proxies) {
      try {
        onProgress?.('Checking Instagram embed metadata...');
        const embedRes = await fetch(proxyFn(embedUrl));
        if (embedRes.ok) {
          const html = await embedRes.text();
          const videoMatch =
            html.match(/video_url\\":\\"([^"\\]+)/) ||
            html.match(/src="([^"]+\.mp4[^"]*)"/) ||
            html.match(/"video_url":"([^"]+)"/);

          if (videoMatch && videoMatch[1]) {
            const cleanVideoUrl = videoMatch[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
            onProgress?.('Downloading video stream...');
            const videoBlob = await fetchWithProgress(cleanVideoUrl, onProgress);
            return {
              id: shortcode,
              sourceUrl: trimmedUrl,
              videoUrl: cleanVideoUrl,
              title: `Instagram Reel (${shortcode})`,
              author: 'Instagram Creator',
              videoBlob,
            };
          }
        }
      } catch {
        // Continue
      }
    }
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

  // Fallback via CORS proxy
  const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(url)}`;
  const proxyRes = await fetch(proxyUrl);
  if (proxyRes.ok) {
    return await proxyRes.blob();
  }

  throw new Error('Unable to download video stream due to network or CORS restrictions.');
}
