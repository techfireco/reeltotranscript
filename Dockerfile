FROM node:24-bookworm-slim AS web
WORKDIR /web
COPY package*.json ./
RUN npm ci
COPY astro.config.mjs tsconfig.json ./
COPY public public
COPY src src
RUN npm run build

FROM python:3.11-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
ENV WHISPER_MODEL=/opt/models/base DATA_DIR=/data WORK_DIR=/tmp/jobs PYTHONDONTWRITEBYTECODE=1
RUN python -c "from faster_whisper.utils import download_model; download_model('base', output_dir='/opt/models/base')" \
 && useradd --uid 10001 --create-home app && mkdir /data && chown app:app /data
COPY --from=web /web/dist dist
COPY backend backend
USER app
EXPOSE 8000
CMD ["gunicorn", "--bind=0.0.0.0:8000", "--workers=1", "--threads=6", "--timeout=90", "backend.app:create_app()"]
