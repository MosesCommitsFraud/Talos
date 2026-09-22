import { brand } from '@/lib/brand';
import { cn } from '@/lib/utils';
import { BrandImage } from './BrandImage';

/** The Talos mark (matches the favicon): two stacked sails over a wave.
 *
 *  Drawn in `currentColor`, so it takes the colour of whatever it sits in — the
 *  sidebar header, or the working row once its animation has settled. A branded
 *  deployment's `logo-small` replaces it (see BrandImage).
 *
 *  `mono` flattens a brand logo to `currentColor` like the Talos mark, for the
 *  greyed-out chat marker; without it the logo keeps its own colours. */
export function TalosLogo({ className, mono = false }: { className?: string; mono?: boolean }) {
  if (brand.logoSmall) {
    return (
      <BrandImage
        src={brand.logoSmall}
        alt=""
        className={cn(
          className,
          // [&_svg_*] outranks the SVG's own class fills; grayscale covers a
          // raster logo, which can only be desaturated.
          mono ? '[&_svg_*]:fill-current grayscale' : 'text-foreground',
        )}
      />
    );
  }
  return (
    <svg viewBox="0 0 32 32" className={className} fill="none" aria-hidden="true">
      <path d="M16 4L16 22L6 22Z" fill="currentColor" />
      <path d="M16 8L16 22L24 22Z" fill="currentColor" opacity="0.6" />
      <path d="M4 24Q10 20 16 24Q22 28 28 24" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
