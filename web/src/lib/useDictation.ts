import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribeVoice } from '@/api/client';

export type DictationStatus = 'idle' | 'recording' | 'finalizing';

/** Push-to-talk dictation for the composer.
 *
 *  Two transports behind one interface:
 *
 *  - **streaming** (preferred, `voice_streaming` capability): raw PCM goes to
 *    the RealtimeSTT sidecar over `/api/voice/stream`; `interim` updates word
 *    by word (partials from the small model, sentences committed by the big
 *    one). Sub-second feedback.
 *  - **batch** (fallback, ASR endpoint only): MediaRecorder clip re-posted to
 *    `/api/voice/transcribe` every few seconds; `interim` updates in batches.
 *
 *  Lifecycle is identical either way: `start()` opens the mic; `confirm()`
 *  (the composer's first Enter) stops it, produces the definitive transcript
 *  and delivers it via `onFinal`; `cancel()` discards everything.
 */

/** Batch fallback: minimum gap between preview transcription requests. */
const PREVIEW_INTERVAL_MS = 3000;
/** Streaming: hard cap on waiting for the sidecar's final pass. */
const FINALIZE_TIMEOUT_MS = 25_000;
/** Streaming: target sample rate the sidecar expects (PCM16 mono). */
const TARGET_RATE = 16_000;

function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

/** AudioWorklet that batches mic samples (~2048 frames) to the main thread.
 *  Inlined via Blob URL so no separate asset needs serving. */
const WORKLET_SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.len = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      this.buf.push(new Float32Array(ch));
      this.len += ch.length;
      if (this.len >= 2048) {
        const out = new Float32Array(this.len);
        let o = 0;
        for (const b of this.buf) { out.set(b, o); o += b.length; }
        this.port.postMessage(out, [out.buffer]);
        this.buf = []; this.len = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
`;

/** Linear-interpolation downsample to 16 kHz, then PCM16. Dictation audio —
 *  fidelity beyond what the ASR consumes doesn't matter. */
function toPcm16k(input: Float32Array, fromRate: number): Int16Array {
  const ratio = fromRate / TARGET_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const s = input[i0] + (input[i1] - input[i0]) * (pos - i0);
    out[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
  }
  return out;
}

export function useDictation(
  onFinal: (text: string) => void,
  opts?: { streaming?: boolean; deviceId?: string | null },
) {
  const streaming = !!opts?.streaming;
  const deviceId = opts?.deviceId ?? null;
  const [status, setStatus] = useState<DictationStatus>('idle');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;
  const statusRef = useRef<DictationStatus>('idle');
  statusRef.current = status;

  // --- shared ---
  const stream = useRef<MediaStream | null>(null);

  // --- streaming transport ---
  const ws = useRef<WebSocket | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const committed = useRef<string[]>([]);
  const lastInterim = useRef('');
  const finalizeTimer = useRef<number | null>(null);

  // --- batch transport ---
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const previewBusy = useRef(false);
  const lastPreviewAt = useRef(0);
  const previewAbort = useRef<AbortController | null>(null);
  const finalizeOnStop = useRef(false);

  const teardown = useCallback(() => {
    if (finalizeTimer.current) window.clearTimeout(finalizeTimer.current);
    finalizeTimer.current = null;
    const sock = ws.current;
    ws.current = null;
    if (sock) {
      sock.onmessage = null;
      sock.onclose = null;
      sock.onerror = null;
      try {
        sock.close();
      } catch {
        /* already closed */
      }
    }
    void audioCtx.current?.close().catch(() => undefined);
    audioCtx.current = null;
    committed.current = [];
    lastInterim.current = '';
    previewAbort.current?.abort();
    previewAbort.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    recorder.current = null;
    chunks.current = [];
    previewBusy.current = false;
    lastPreviewAt.current = 0;
  }, []);

  useEffect(() => teardown, [teardown]);

  // Errors are transient hints, not persistent state — fade them out on their
  // own so a failed attempt doesn't leave a red line under the composer.
  useEffect(() => {
    if (!error) return;
    const id = window.setTimeout(() => setError(null), 5000);
    return () => window.clearTimeout(id);
  }, [error]);

  const finish = useCallback(
    (text: string) => {
      teardown();
      if (text) onFinalRef.current(text);
      setStatus('idle');
      setInterim('');
    },
    [teardown],
  );

  // ---------- streaming path ----------

  const startStreaming = useCallback(
    async (media: MediaStream) => {
      const ctx = new AudioContext();
      audioCtx.current = ctx;
      const moduleUrl = URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: 'application/javascript' }),
      );
      try {
        await ctx.audioWorklet.addModule(moduleUrl);
      } finally {
        URL.revokeObjectURL(moduleUrl);
      }

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const sock = new WebSocket(`${proto}//${window.location.host}/api/voice/stream`);
      sock.binaryType = 'arraybuffer';
      ws.current = sock;
      committed.current = [];
      lastInterim.current = '';

      sock.onmessage = (ev) => {
        let msg: { type?: string; text?: string; error?: string };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.type === 'partial') {
          lastInterim.current = [...committed.current, msg.text ?? ''].join(' ').trim();
          setInterim(lastInterim.current);
        } else if (msg.type === 'sentence') {
          if (msg.text) committed.current.push(msg.text);
          lastInterim.current = committed.current.join(' ');
          setInterim(lastInterim.current);
        } else if (msg.type === 'final') {
          finish((msg.text ?? '').trim() || lastInterim.current.trim());
        } else if (msg.type === 'error') {
          setError('transcribe-failed');
          finish('');
        }
      };
      // A drop mid-dictation salvages whatever text already arrived rather
      // than throwing the user's words away.
      sock.onclose = () => {
        if (ws.current !== sock) return; // deliberate teardown
        const salvage = lastInterim.current.trim();
        if (!salvage) setError('transcribe-failed');
        finish(salvage);
      };
      sock.onerror = () => {
        /* onclose follows and handles it */
      };

      const source = ctx.createMediaStreamSource(media);
      const node = new AudioWorkletNode(ctx, 'pcm-capture');
      node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        if (sock.readyState === WebSocket.OPEN && statusRef.current === 'recording') {
          sock.send(toPcm16k(e.data, ctx.sampleRate).buffer);
        }
      };
      source.connect(node);
      // Worklets need a destination to be pulled; route through zero gain so
      // the mic is never audible.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(ctx.destination);
      setStatus('recording');
    },
    [finish],
  );

  const confirmStreaming = useCallback(() => {
    const sock = ws.current;
    if (!sock) return;
    setStatus('finalizing');
    // Stop capturing but keep the socket for the final transcript.
    stream.current?.getTracks().forEach((t) => t.stop());
    try {
      sock.send(JSON.stringify({ type: 'stop' }));
    } catch {
      finish(lastInterim.current.trim());
      return;
    }
    finalizeTimer.current = window.setTimeout(() => {
      finish(lastInterim.current.trim());
    }, FINALIZE_TIMEOUT_MS);
  }, [finish]);

  // ---------- batch (HTTP polling) path ----------

  const runPreview = useCallback(async (mime: string) => {
    if (previewBusy.current || !chunks.current.length) return;
    if (Date.now() - lastPreviewAt.current < PREVIEW_INTERVAL_MS) return;
    previewBusy.current = true;
    lastPreviewAt.current = Date.now();
    const ctrl = new AbortController();
    previewAbort.current = ctrl;
    try {
      // MediaRecorder chunks are only decodable as a whole (the container
      // header lives in the first chunk), so previews always send everything.
      const text = await transcribeVoice(new Blob(chunks.current, { type: mime }), ctrl.signal);
      // A finalize/cancel may have landed while we were waiting — don't revive.
      if (recorder.current && recorder.current.state === 'recording' && text) setInterim(text);
    } catch {
      // Preview failures are cosmetic; the finalize pass is the one that counts.
    } finally {
      previewBusy.current = false;
      if (previewAbort.current === ctrl) previewAbort.current = null;
    }
  }, []);

  const startBatch = useCallback(
    (media: MediaStream) => {
      const mime = pickMimeType();
      const rec = new MediaRecorder(media, mime ? { mimeType: mime } : undefined);
      recorder.current = rec;
      chunks.current = [];
      finalizeOnStop.current = false;

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data);
        if (rec.state === 'recording') void runPreview(rec.mimeType || mime || 'audio/webm');
      };
      rec.onstop = () => {
        const blob = new Blob(chunks.current, { type: rec.mimeType || mime || 'audio/webm' });
        const finalize = finalizeOnStop.current;
        teardown();
        if (!finalize || blob.size === 0) {
          setStatus('idle');
          setInterim('');
          return;
        }
        void (async () => {
          try {
            const text = await transcribeVoice(blob);
            if (text) onFinalRef.current(text);
          } catch {
            setError('transcribe-failed');
          } finally {
            setStatus('idle');
            setInterim('');
          }
        })();
      };
      rec.start(1000);
      setStatus('recording');
    },
    [runPreview, teardown],
  );

  const confirmBatch = useCallback(() => {
    const rec = recorder.current;
    if (!rec || rec.state === 'inactive') return;
    finalizeOnStop.current = true;
    previewAbort.current?.abort();
    setStatus('finalizing');
    rec.stop();
  }, []);

  // ---------- public API ----------

  const start = useCallback(async () => {
    if (statusRef.current !== 'idle') return;
    setError(null);
    setInterim('');
    // getUserMedia only exists in secure contexts (https or localhost). Over
    // plain http on a LAN IP the browser never even asks — surface that as
    // its own error instead of pretending the user denied permission.
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('insecure-context');
      return;
    }
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
    } catch {
      // The picked mic may have been unplugged — retry with the default
      // before giving up (a plain failure there really is a permission issue).
      if (!deviceId) {
        setError('mic-denied');
        return;
      }
      try {
        media = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        setError('mic-denied');
        return;
      }
    }
    stream.current = media;
    try {
      if (streaming) await startStreaming(media);
      else startBatch(media);
    } catch {
      teardown();
      setError('transcribe-failed');
      setStatus('idle');
    }
  }, [streaming, deviceId, startStreaming, startBatch, teardown]);

  /** First Enter / mic click while recording: stop and turn the speech into
   *  committed text. The hook reports 'finalizing' until `onFinal` has fired. */
  const confirm = useCallback(() => {
    if (statusRef.current !== 'recording') return;
    if (ws.current) confirmStreaming();
    else confirmBatch();
  }, [confirmStreaming, confirmBatch]);

  const cancel = useCallback(() => {
    const rec = recorder.current;
    if (rec && rec.state !== 'inactive') {
      finalizeOnStop.current = false;
      rec.stop(); // onstop tears down
      return;
    }
    teardown();
    setStatus('idle');
    setInterim('');
  }, [teardown]);

  return { status, interim, error, start, confirm, cancel };
}
