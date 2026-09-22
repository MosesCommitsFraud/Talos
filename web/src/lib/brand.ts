/** Deployment branding (TALOS_BRAND, see core/branding.py). The server bakes it
 *  into index.html as <meta name="talos-brand">, so it is known synchronously
 *  before the first render — no request, no flash of "Talos". A missing tag
 *  (vite dev server) or missing logo falls back to the built-in Talos look. */
export interface Brand {
  name: string;
  /** URL of the square mark, or null for the built-in Talos sails. */
  logoSmall: string | null;
  /** URL of the wide logo, or null to show the name as text. */
  logoLarge: string | null;
}

function readBrand(): Brand {
  const fallback: Brand = { name: 'Talos', logoSmall: null, logoLarge: null };
  try {
    const raw = document.querySelector('meta[name="talos-brand"]')?.getAttribute('content');
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export const brand: Brand = readBrand();
