import { pcmToWavBlob } from './audio-extractor';

export interface TranscriptionChunk {
  timestamp?: [number, number] | null;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  chunks: TranscriptionChunk[];
  processingTime: string;
  modelUsed: string;
  engine: 'browser-whisper' | 'groq-whisper' | 'hf-whisper';
}

export type ProgressCallback = (event: {
  phase: 'idle' | 'audio-extracting' | 'model-loading' | 'transcribing' | 'completed' | 'error';
  message: string;
  progressPercent: number;
  details?: Record<string, unknown>;
}) => void;

class TranscriberService {
  private worker: Worker | null = null;
  private isModelReady = false;
  private currentModel = 'onnx-community/whisper-tiny';

  /**
   * Initializes or returns the singleton Web Worker
   */
  private getWorker(onProgress?: ProgressCallback): Worker {
    if (!this.worker && typeof window !== 'undefined') {
      this.worker = new Worker('/workers/whisper-worker.js', { type: 'module' });

      this.worker.addEventListener('error', (err) => {
        console.error('Worker runtime error:', err);
        onProgress?.({
          phase: 'error',
          message: `Worker error: ${err.message || 'Worker thread crashed'}`,
          progressPercent: 0,
        });
      });
    }
    return this.worker!;
  }

  /**
   * Run client-side transcription using Whisper in Web Worker
   */
  public async transcribeInBrowser(
    audioSamples: Float32Array,
    options: {
      model?: string;
      language?: string;
      onProgress?: ProgressCallback;
    } = {}
  ): Promise<TranscriptionResult> {
    const { model = 'onnx-community/whisper-tiny', language = 'auto', onProgress } = options;
    const worker = this.getWorker(onProgress);

    return new Promise((resolve, reject) => {
      const handleMessage = (event: MessageEvent) => {
        const data = event.data;

        switch (data.status) {
          case 'loading':
            onProgress?.({
              phase: 'model-loading',
              message: data.message,
              progressPercent: data.progress || 10,
            });
            break;

          case 'model-download-progress':
            onProgress?.({
              phase: 'model-loading',
              message: `Downloading AI model (${data.file}): ${data.progress}%`,
              progressPercent: data.progress,
              details: { loaded: data.loaded, total: data.total, file: data.file },
            });
            break;

          case 'ready':
            this.isModelReady = true;
            this.currentModel = model;
            onProgress?.({
              phase: 'model-loading',
              message: 'Whisper model ready in browser memory.',
              progressPercent: 100,
            });
            break;

          case 'transcribing':
            onProgress?.({
              phase: 'transcribing',
              message: 'Transcribing speech to text locally in browser...',
              progressPercent: 65,
            });
            break;

          case 'complete':
            worker.removeEventListener('message', handleMessage);
            onProgress?.({
              phase: 'completed',
              message: `Transcribed in ${data.result.processingTime}s`,
              progressPercent: 100,
            });
            resolve({
              text: data.result.text.trim(),
              chunks: data.result.chunks || [],
              processingTime: data.result.processingTime,
              modelUsed: model,
              engine: 'browser-whisper',
            });
            break;

          case 'error':
            worker.removeEventListener('message', handleMessage);
            onProgress?.({
              phase: 'error',
              message: data.error,
              progressPercent: 0,
            });
            reject(new Error(data.error));
            break;
        }
      };

      worker.addEventListener('message', handleMessage);

      // Post transcribe job to worker
      worker.postMessage({
        type: 'transcribe',
        data: {
          audioData: audioSamples,
          model,
          language: language === 'auto' ? null : language,
          returnTimestamps: true,
        },
      });
    });
  }

  /**
   * Transcribe via Groq Cloud API (Free tier provides ultra-fast Whisper Large v3)
   */
  public async transcribeWithGroq(
    audioSamples: Float32Array,
    apiKey: string,
    options: {
      language?: string;
      onProgress?: ProgressCallback;
    } = {}
  ): Promise<TranscriptionResult> {
    const { language, onProgress } = options;
    onProgress?.({
      phase: 'audio-extracting',
      message: 'Packaging 16kHz WAV audio for Groq Whisper Cloud...',
      progressPercent: 20,
    });

    const startTime = performance.now();
    const wavBlob = pcmToWavBlob(audioSamples, 16000);

    const formData = new FormData();
    formData.append('file', wavBlob, 'audio.wav');
    formData.append('model', 'whisper-large-v3');
    formData.append('response_format', 'verbose_json');
    if (language && language !== 'auto') {
      formData.append('language', language);
    }

    onProgress?.({
      phase: 'transcribing',
      message: 'Sending to Groq Whisper Large v3 Cloud...',
      progressPercent: 50,
    });

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errJson = await response.json().catch(() => ({}));
      const msg = errJson.error?.message || `Groq API responded with status ${response.status}`;
      throw new Error(`Groq Whisper failed: ${msg}`);
    }

    const json = await response.json();
    const processingTime = ((performance.now() - startTime) / 1000).toFixed(2);

    const chunks: TranscriptionChunk[] = (json.segments || []).map((seg: any) => ({
      timestamp: [seg.start, seg.end],
      text: seg.text || '',
    }));

    onProgress?.({
      phase: 'completed',
      message: `Completed via Groq Whisper in ${processingTime}s`,
      progressPercent: 100,
    });

    return {
      text: (json.text || '').trim(),
      chunks,
      processingTime,
      modelUsed: 'whisper-large-v3 (Groq Cloud)',
      engine: 'groq-whisper',
    };
  }

  /**
   * Terminate worker to free memory
   */
  public dispose() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.isModelReady = false;
    }
  }
}

export const transcriberService = new TranscriberService();
