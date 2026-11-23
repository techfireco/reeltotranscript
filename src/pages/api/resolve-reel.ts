import type { APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const targetUrl = url.searchParams.get('url');

  if (!targetUrl) {
    return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // 1. Try yt-dlp if running in Node.js environment
    if (typeof process !== 'undefined' && process.versions?.node) {
      try {
        const { exec } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execAsync = promisify(exec);

        const { stdout } = await execAsync(
          `yt-dlp -g --no-warnings "${targetUrl.replace(/"/g, '\\"')}"`,
          { timeout: 8000 }
        );

        const videoUrl = stdout.trim().split('\n')[0];
        if (videoUrl && videoUrl.startsWith('http')) {
          return new Response(
            JSON.stringify({
              videoUrl,
              title: 'Extracted Video Stream',
              source: 'yt-dlp',
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
      } catch (ytdlErr) {
        // Fallback to web resolvers
      }
    }

    // 2. Try Instagram Web API with x-ig-app-id header
    const shortcodeMatch = targetUrl.match(/(?:instagram\.com\/(?:reel|reels|p|share\/reel)\/)([A-Za-z0-9_-]+)/i);
    if (shortcodeMatch && shortcodeMatch[1]) {
      const shortcode = shortcodeMatch[1];
      const igApiUrl = `https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`;

      try {
        const igRes = await fetch(igApiUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
            'x-ig-app-id': '936619743392459',
            'Sec-Fetch-Mode': 'cors',
            'Accept': '*/*',
          },
        });

        if (igRes.ok) {
          const data = await igRes.json();
          const item = data.graphql?.shortcode_media || data.items?.[0];
          const videoUrl = item?.video_versions?.[0]?.url || item?.video_url;

          if (videoUrl) {
            return new Response(
              JSON.stringify({
                videoUrl,
                title: item?.caption?.text || `Instagram Reel (${shortcode})`,
                author: item?.user?.username || item?.owner?.username || 'Instagram Creator',
                thumbnailUrl: item?.image_versions2?.candidates?.[0]?.url || item?.display_url,
                source: 'instagram-web-api',
              }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }
            );
          }
        }
      } catch {
        // Fallback
      }
    }

    // 3. Try open SnapSave scraper
    try {
      const { snapsave } = await import('snapsave-media-downloader');
      const snapRes = await snapsave(targetUrl);
      if (snapRes && (snapRes as any).data && Array.isArray((snapRes as any).data)) {
        const videoItem =
          (snapRes as any).data.find((d: any) => d.url && (d.url.includes('.mp4') || d.type === 'video')) ||
          (snapRes as any).data[0];
        if (videoItem?.url) {
          return new Response(
            JSON.stringify({
              videoUrl: videoItem.url,
              title: (snapRes as any).title || 'Instagram Reel',
              thumbnailUrl: (snapRes as any).thumbnail,
              source: 'snapsave',
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
      }
    } catch {
      // Fallback
    }

    return new Response(
      JSON.stringify({
        error:
          'Instagram has restricted automated scraping for this Reel. Please use the direct Upload tab or download helper.',
      }),
      {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
