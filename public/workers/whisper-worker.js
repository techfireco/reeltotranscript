/**
 * Whisper Web Worker
 * Runs open-source OpenAI Whisper in-browser using Transformers.js with ONNX Runtime Web.
 * 100% Client-Side, Private, Offline-Capable.
 */

let transcriber = null;
let currentModel = null;

// Listen for messages from main thread
self.addEventListener('message', async (event) => {
  const { type, data } = event.data;

  try {
    if (type === 'init' || type === 'load') {
      const modelId = data?.model || 'onnx-community/whisper-tiny';
      await loadModel(modelId, data?.subtask || 'transcribe');
      self.postMessage({ status: 'ready', model: modelId });
    } else if (type === 'transcribe') {
      const { audioData, model = 'onnx-community/whisper-tiny', language = null, returnTimestamps = true } = data;
      
      // Ensure model is loaded
      if (!transcriber || currentModel !== model) {
        await loadModel(model);
      }

      self.postMessage({ status: 'transcribing', progress: 0, message: 'Processing audio stream...' });

      const startTime = performance.now();
      
      // Configure generation parameters
      const generateKwargs = {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: returnTimestamps,
      };

      if (language && language !== 'auto') {
        generateKwargs.language = language;
        generateKwargs.task = 'transcribe';
      }

      // Run inference
      const output = await transcriber(audioData, generateKwargs);
      const processingTime = ((performance.now() - startTime) / 1000).toFixed(2);

      self.postMessage({
        status: 'complete',
        result: {
          text: output.text || '',
          chunks: output.chunks || [],
          processingTime,
        },
      });
    }
  } catch (error) {
    console.error('Worker error:', error);
    self.postMessage({
      status: 'error',
      error: error.message || String(error),
    });
  }
});

async function loadModel(modelId) {
  if (transcriber && currentModel === modelId) {
    return transcriber;
  }

  self.postMessage({
    status: 'loading',
    message: `Loading Whisper model (${modelId.replace('onnx-community/', '')})...`,
    progress: 5,
  });

  // Import Transformers.js
  const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3');

  // Configure environment for browser execution
  env.allowLocalModels = false;
  env.useBrowserCache = true;

  transcriber = await pipeline('automatic-speech-recognition', modelId, {
    progress_callback: (data) => {
      if (data.status === 'progress') {
        const percent = Math.round((data.loaded / data.total) * 100);
        self.postMessage({
          status: 'model-download-progress',
          file: data.file,
          loaded: data.loaded,
          total: data.total,
          progress: percent,
        });
      } else if (data.status === 'ready') {
        self.postMessage({
          status: 'model-file-ready',
          file: data.file,
        });
      }
    },
    device: 'wasm', // or webgpu if available
  });

  currentModel = modelId;
  return transcriber;
}
