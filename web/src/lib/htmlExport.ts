import imageRuntime from 'html-to-image/dist/html-to-image.js?raw';
import bridge from './html-export-bridge.js?raw';

// Match the HTML artifact routes. srcDoc must not drop their network restrictions.
const CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
const script = (source: string) => `<script>${source.replace(/<\/script/gi, '<\\/script')}</script>`;

export function htmlPreviewDocument(html: string): string {
  // The leading CSP also covers malformed/full-document HTML appended afterwards.
  // Hide controls in old Talos artifacts; current artifacts contain no toolbar.
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>#td-downloads{display:none!important}</style>`
    + script(imageRuntime) + script(bridge) + html;
}

export async function requestHtmlPng(frame: Window, signal: AbortSignal): Promise<Blob> {
  const id = crypto.randomUUID();
  const blob = await new Promise<Blob>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', receive); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new DOMException('Export cancelled', 'AbortError')); };
    const receive = (event: MessageEvent) => {
      // Opaque frames have origin "null"; bind to the exact live frame and request.
      if (event.source !== frame || event.data?.type !== 'talos:export-result' || event.data.id !== id) return;
      cleanup();
      if (typeof event.data.error === 'string') { reject(new Error(event.data.error.slice(0, 500))); return; }
      const value = event.data.blob;
      if (!(value instanceof Blob) || value.type !== 'image/png' || value.size < 24 || value.size > 128 * 1024 * 1024) {
        reject(new Error('Invalid PNG response')); return;
      }
      resolve(value);
    };
    const timer = window.setTimeout(() => { cleanup(); reject(new Error('PNG export timed out')); }, 30000);
    window.addEventListener('message', receive);
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) { abort(); return; }
    frame.postMessage({type: 'talos:export-png', id}, '*');
  });
  const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  if (!signature.every((v, i) => v === [137, 80, 78, 71, 13, 10, 26, 10][i])) throw new Error('Invalid PNG signature');
  if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
  return blob;
}

export function savePreviewBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}
