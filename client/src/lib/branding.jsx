// Business branding (logo + main color). Loaded from the public /api/branding endpoint so the
// login screen is branded too, and cached locally so the color shows instantly on the next visit.
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

const DEFAULT_COLOR = '#0071e3';
// The color of the old look; businesses that never picked their own color get the new default.
const OLD_DEFAULT = '#4f46e5';
const BrandCtx = createContext({ logo: '', business_name: '', brand_color: DEFAULT_COLOR, reload: () => {} });

function readCache() {
  try { return JSON.parse(localStorage.getItem('branding') || 'null'); } catch { return null; }
}

/** Override the primary color tokens (light + dark) from one brand color. */
export function applyBrandColor(color) {
  let el = document.getElementById('brand-vars');
  if (!color || !/^#[0-9a-f]{6}$/i.test(color) || [DEFAULT_COLOR, OLD_DEFAULT].includes(color.toLowerCase())) { el?.remove(); return; }
  if (!el) { el = document.createElement('style'); el.id = 'brand-vars'; document.head.appendChild(el); }
  const c = color;
  el.textContent = `
:root{--primary:${c};--primary-hover:color-mix(in srgb,${c} 82%,#000);--primary-soft:color-mix(in srgb,${c} 11%,#fff);--primary-text:color-mix(in srgb,${c} 80%,#000);--focus:0 0 0 3px color-mix(in srgb,${c} 28%,transparent);}
:root[data-theme='dark']{--primary:color-mix(in srgb,${c} 70%,#fff);--primary-hover:color-mix(in srgb,${c} 55%,#fff);--primary-soft:color-mix(in srgb,${c} 24%,#000);--primary-text:color-mix(in srgb,${c} 45%,#fff);}`;
}

export function BrandingProvider({ children }) {
  const [brand, setBrand] = useState(() => readCache() || { logo: '', business_name: '', brand_color: DEFAULT_COLOR });
  const reload = useCallback(async () => {
    try {
      const b = await api.get('/branding');
      setBrand(b);
      try { localStorage.setItem('branding', JSON.stringify(b)); } catch { /* storage unavailable */ }
    } catch { /* offline: keep the cached branding */ }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { applyBrandColor(brand.brand_color); }, [brand.brand_color]);
  return <BrandCtx.Provider value={{ ...brand, reload }}>{children}</BrandCtx.Provider>;
}

export const useBranding = () => useContext(BrandCtx);

/** The business logo, or the default app icon. */
export function BrandLogo({ fallback: Fallback, className = 'brand-logo', style }) {
  const { logo, business_name: name } = useBranding();
  if (logo) return <img src={logo} alt={name || ''} className={`${className} has-img`} style={style} />;
  return <div className={className} style={style}><Fallback size={20} /></div>;
}
