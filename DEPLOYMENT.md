# Deploying Reel to Transcript

The Docker image serves the Astro pages and the transcription API together. It includes FFmpeg, yt-dlp and a multilingual Whisper model downloaded at build time. The Compose stack publishes the site through an outbound Cloudflare Tunnel. It does not publish host ports.

## Production configuration

1. In Google Cloud, create a web OAuth client and enable it for the intended audience. Register the exact redirect URI `https://reeltotranscript.com/auth/callback`. Use your own hostname in this URI and the Astro site metadata if it differs.
2. Register a managed Turnstile widget for the public hostname. Configure a Cloudflare Tunnel published application for the same hostname, with its service set to `http://app:8000`. Preserve the public Host header. Enable the HTTPS redirect at the edge.
3. In the deployment environment set `PUBLIC_ORIGIN` (the public HTTPS origin, without a trailing slash), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` and `TUNNEL_TOKEN`. Keep secret values in the deployment secret store. The Turnstile site key is designed for the browser.
4. Deploy `compose.yaml` as one application instance, with its persistent `ledger` volume. Use one Gunicorn worker as configured. Each process owns its temporary results and running jobs. Back up the volume and retain it on redeploy. Stop the previous instance before starting a replacement against the same volume.
5. Before switching public traffic, disable the old resolver, stream proxy and Cobalt public routes at the proxy and firewall, after checking other consumers. Remove obsolete public DNS records and invalidate old frontend assets in the CDN. Restrict access to the management dashboard separately. Prior commits and cached clients can retain previously published addresses.
6. Verify live Google sign-in, complete the widget, submit an authorized public Reel and export its transcript. Sign in with the same account in a second browser to check the remaining balance. Confirm that the old services no longer accept public requests.

## Local verification

Run `npm ci` and `npm run build` to produce the frontend. The Astro dev server and Astro preview serve only the UI. The Python app serves the complete built site. With Python 3.11, install `backend/requirements.txt` in a virtual environment and run `python -m unittest discover -s tests -v`. The route tests use fixtures for external authentication, challenge verification and speech recognition.

The production image loads its model from `/opt/models/base`. A local media test can set `WHISPER_MODEL` to a downloaded faster-whisper model directory and use `python -m backend.media PRIVATE_WORK_DIR ''` with a file named `input` inside that private directory. This writes a temporary WAV and prints the transcript. The HTTP service cleans up job directories automatically.

## Operating limits

Each verified Google account can finish three jobs per India calendar day. A reservation counts toward the day it started. A failed or interrupted job releases its slot. Results remain available to their owner for 15 minutes while the process is running. A service restart clears in-memory results and retains the daily ledger. Media is limited to 25 MiB and three minutes, with at most two simultaneous jobs across the service. There is no payment system, administrative role, public bucket or webhook in this application.
