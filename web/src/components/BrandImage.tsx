import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

/* SVG logos are inlined rather than shown as <img>, so a `fill: currentColor`
 * in them follows the app's own light/dark theme (the .dark class), not just
 * the OS setting an <img> would see. Other formats stay plain images. */
const svgCache = new Map<string, Promise<string | null>>();

function loadSvg(src: string): Promise<string | null> {
  let pending = svgCache.get(src);
  if (!pending) {
    pending = fetch(src)
      .then(async (res) => {
        if (!res.ok || !res.headers.get('content-type')?.includes('svg')) return null;
        const doc = new DOMParser().parseFromString(await res.text(), 'image/svg+xml');
        const svg = doc.documentElement;
        if (svg.nodeName !== 'svg') return null;
        doc.querySelectorAll('script, foreignObject').forEach((n) => n.remove());
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.setAttribute('aria-hidden', 'true');
        svg.removeAttribute('preserveAspectRatio'); // re-added per `align` below
        return svg.outerHTML;
      })
      .catch(() => null);
    svgCache.set(src, pending);
  }
  return pending;
}

export function BrandImage({
  src,
  alt,
  className,
  align = 'center',
}: {
  src: string;
  alt: string;
  className?: string;
  /** Where the logo sits inside a box wider than its aspect ratio. */
  align?: 'center' | 'left';
}) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void loadSvg(src).then((markup) => {
      if (live) setSvg(markup && align === 'left' ? markup.replace('<svg', '<svg preserveAspectRatio="xMinYMid meet"') : markup);
    });
    return () => { live = false; };
  }, [src, align]);

  if (svg) {
    return (
      <span role="img" aria-label={alt || undefined} aria-hidden={alt ? undefined : true}
        className={cn('block', className)} dangerouslySetInnerHTML={{ __html: svg }} />
    );
  }
  return (
    <img src={src} alt={alt} aria-hidden={alt ? undefined : true}
      className={cn('object-contain', align === 'left' && 'object-left', className)} />
  );
}
