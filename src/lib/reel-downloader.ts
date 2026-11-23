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

/**
 * Extracts the Instagram shortcode from various Instagram URL formats
 */
export function extractInstagramShortcode(url: string): string | null {
  try {
    const trimmed = url.trim();
    // Patterns:
    // instagram.com/reel/Cxxxxxx/
    // instagram.com/reels/Cxxxxxx/
    // instagram.com/p/Cxxxxxx/
    // instagram.com/share/reel/Cxxxxxx/
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
 * Validates if the given string is a valid Instagram Reel / Post URL
 */
export function isValidInstagramUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  const shortcode = extractInstagramShortcode(url);
  return Boolean(shortcode);
}

/**
 * Resolves an Instagram Reel to a downloadable video URL or video Blob
 */
export async function resolveReel(
  url: string,
  onProgress?: (msg: string) => void
): Promise<ReelMetadata> {
  const shortcode = extractInstagramShortcode(url);
  if (!shortcode) {
    throw new Error('Please enter a valid Instagram Reel or Video URL (e.g. https://www.instagram.com/reel/C123...)');
  }

  onProgress?.('Fetching Reel metadata and video stream...');

  // Attempt 1: Call internal API endpoint /api/resolve-reel if running with SSR / Cloudflare Workers
  try {
    const res = await fetch(`/api/resolve-reel?url=${encodeURIComponent(url)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.videoUrl) {
        onProgress?.('Downloading video stream for browser transcription...');
        const videoBlob = await fetchWithProgress(data.videoUrl, onProgress);
        return {
          id: shortcode,
          sourceUrl: url,
          videoUrl: data.videoUrl,
          title: data.title || `Instagram Reel (${shortcode})`,
          author: data.author || '@instagram_creator',
          thumbnailUrl: data.thumbnailUrl,
          videoBlob,
        };
      }
    }
  } catch (err) {
    console.warn('Internal API resolver failed, trying fallback resolvers:', err);
  }

  // Attempt 2: Public open cobalt API endpoint
  try {
    onProgress?.('Connecting to public video resolver...');
    const cobaltRes = await fetch('https://api.cobalt.tools/api/json', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: url.trim(),
        videoQuality: '720',
      }),
    });

    if (cobaltRes.ok) {
      const cobaltData = await cobaltRes.json();
      if (cobaltData.url) {
        onProgress?.('Downloading video stream...');
        const videoBlob = await fetchWithProgress(cobaltData.url, onProgress);
        return {
          id: shortcode,
          sourceUrl: url,
          videoUrl: cobaltData.url,
          title: cobaltData.filename || `Instagram Reel (${shortcode})`,
          author: 'Instagram Creator',
          videoBlob,
        };
      }
    }
  } catch (err) {
    console.warn('Cobalt API attempt failed:', err);
  }

  // Attempt 3: Public CORS proxy Instagram embed scraper
  try {
    onProgress?.('Inspecting Instagram embed details via proxy...');
    const embedUrl = `https://www.instagram.com/reel/${shortcode}/embed/captioned/`;
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(embedUrl)}`;
    
    const embedRes = await fetch(proxyUrl);
    if (embedRes.ok) {
      const html = await embedRes.text();
      
      // Look for video URL in embed HTML
      const videoMatch = html.match(/video_url\\":\\"([^"\\]+)/) || 
                         html.match(/src="([^"]+\.mp4[^"]*)"/) ||
                         html.match(/"video_url":"([^"]+)"/);
      
      if (videoMatch && videoMatch[1]) {
        let cleanVideoUrl = videoMatch[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
        onProgress?.('Downloading video stream from source...');
        const videoBlob = await fetchWithProgress(cleanVideoUrl, onProgress);
        return {
          id: shortcode,
          sourceUrl: url,
          videoUrl: cleanVideoUrl,
          title: `Instagram Reel (${shortcode})`,
          author: 'Instagram Creator',
          videoBlob,
        };
      }
    }
  } catch (err) {
    console.warn('Embed proxy scraper failed:', err);
  }

  throw new Error(
    `Instagram has restricted direct automated downloading for this Reel. ` +
    `You can quickly download the Reel or upload the MP4/video file directly using the "Upload Video" tab below!`
  );
}

/**
 * Fetches a video blob via direct fetch or CORS fallback
 */
async function fetchWithProgress(
  url: string,
  onProgress?: (msg: string) => void
): Promise<Blob> {
  try {
    // Try direct fetch first
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
