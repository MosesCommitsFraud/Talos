// Injected into the opaque preview iframe, never evaluated in the app's origin.
(() => {
  let busy = false;
  window.addEventListener('message', async event => {
    if (event.source !== window.parent || window.parent === window) return;
    const message = event.data;
    if (message?.type !== 'talos:export-png' || typeof message.id !== 'string' || message.id.length > 100) return;
    const reply = data => event.source.postMessage({type: 'talos:export-result', id: message.id, ...data}, '*');
    if (busy) { reply({error: 'An export is already running.'}); return; }
    busy = true;
    try {
      let blob;
      if (typeof window.TALOS_EXPORT?.png === 'function') {
        blob = await window.TALOS_EXPORT.png();
      } else {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const body = document.body;
        const width = body.scrollWidth, height = Math.max(body.scrollHeight, body.offsetHeight);
        if (width * height * 4 > 32000000 || width * 2 > 16000 || height * 2 > 16000) {
          throw new Error('Page is too large for PNG. Split it into smaller pages.');
        }
        blob = await window.htmlToImage.toBlob(body, {width, height, pixelRatio: 2});
      }
      if (!(blob instanceof Blob) || blob.type !== 'image/png') throw new Error('PNG rendering failed.');
      reply({blob});
    } catch (error) {
      reply({error: String(error?.message || error).slice(0, 500)});
    } finally { busy = false; }
  });
})();
