import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { CoverImage } from '../../contracts/player.ts';
import { FROST, frostVars } from '../lib/frost.ts';
import type { FrostSurface } from '../lib/frost.ts';
import { useSurface } from '../lib/surface.tsx';
import { CoverLight } from './CoverLight.tsx';

/**
 * Frost (R2.2): the album's colours, blurred, under a fine-grained field of paper — the stage's
 * material, shared by the surfaces that carry an album. Place it first inside a positioned,
 * isolated container; the container takes useFrostStyle(surface). Decorative.
 */
export function Frost({ cover, className, style }: { cover: CoverImage | null; className?: string; style?: CSSProperties }) {
  return <CoverLight cover={cover} style={style} className={className ? `cdp-frost ${className}` : 'cdp-frost'} />;
}

/**
 * Style for a frost container: how strong the light and the field are in this theme, and the
 * text tones that read on it whatever the cover (see lib/frost.ts).
 */
export function useFrostStyle(surface: FrostSurface): CSSProperties {
  const { theme, settings } = useSurface();
  return useMemo(() => frostVars(theme, FROST[surface][theme], settings.accentColor) as CSSProperties,
    [theme, surface, settings.accentColor]);
}
