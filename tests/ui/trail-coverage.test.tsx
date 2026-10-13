/**
 * V1.2 star-trail completion (Claude, round 4): every stretch of a lit ring that is seen on the
 * glass gets the light's head once a cycle, the light shows nowhere else, it never jumps where it
 * can be seen, and its head is the music field's peak colour with a moderate white.
 *
 * Checked against the sky itself, not against the windows the arithmetic returns. A trail point is
 * seen when it is in the stage and not under what stands in front of the trails: the lines of text
 * set, the controls, the cover and everything before the text column, the music field, the
 * memorial etching's box, or the middle of the cut round it (where the sky's mask hides the trails
 * completely). Of the seen points, those within the head glow's clearance of that content (8px;
 * 6px round the etching's box) are left out on purpose and counted apart. Every other seen point
 * of a lit ring, ends and slivers included, must be in the light's clip, where its head passes once
 * a turn. The etching's own outline (its box's empty corners carry light too), the sky's mask and
 * the real pixels are checked in a browser by tests/ui/stage-coverage.browser.mjs; the light's
 * states and bounds by stage-light.test.tsx.
 */
import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import type { ActionResult, UIAction, UISnapshot } from '../../src/contracts/player.ts';
import { createMockSession } from '../../src/mock/createMockBridge.ts';
import { PlayerUI } from '../../src/ui/PlayerUI.tsx';
import { UIBootContext } from '../../src/ui/lib/env.ts';
import * as light from '../../src/ui/lib/trailLight.ts';
import { chooseLightArcs, lightClipPath, lightMeteor, lightPath, lightSchedule, GLOW, TRANSIT_MS } from '../../src/ui/lib/trailLight.ts';
import type { Box, KeepItem, LightArc, Point, TrailArc } from '../../src/ui/lib/trailLight.ts';
import { TRAILS, TRAILS_BOX } from '../../src/ui/components/StarTrails.tsx';

const read = (p: string) => readFileSync(p, 'utf8');
const TURN = Math.PI * 2;
/** The glow's clearance round what stands in front of the trails, and round the memorial etching's box (lib/trailLight.ts CLEAR, ETCH_CLEAR). */
const CLEARANCE = 8, ETCH_CLEARANCE = 6;

interface Scene { name: string; stage: Box; pole: Point; items: KeepItem[]; trails?: TrailArc[]; rings?: number[] }

/*
 * Stages as the browser lays them out (preview stills, accent #DB7A3D): the stage, the sky's pole
 * and what it marks with data-keep-clear, as components/TrailLight.tsx measures them. `rings` are
 * the radii round 2 lit there: the composition stays.
 */
const STAGES: Scene[] = [
  { name: 'charcoal 2100 900 stage-short', stage: { x: 0, y: 0, w: 1654, h: 312.1 }, pole: { x: 1547.4, y: 74.9 },
    rings: [39.7, 60.2, 93.6, 195.1, 229.5, 330.1, 394.1, 468.3],
    items: [{ kind: 'etch', box: { x: 1477.3, y: 176.1, w: 140.7, h: 112 } },
      { kind: 'box', box: { x: 30, y: 48, w: 216, h: 216 } },
      { kind: 'start', box: { x: 389, y: 24, w: 1221, h: 264.1 } },
      { kind: 'box', box: { x: 389, y: 24, w: 142.3, h: 19.5 } },
      { kind: 'text', box: { x: 389, y: 53.5, w: 158.6, h: 44.1 }, lines: [{ x: 389, y: 53.5, w: 158.6, h: 44.1 }] },
      { kind: 'text', box: { x: 389, y: 104.6, w: 129.8, h: 24 }, lines: [{ x: 389, y: 104.6, w: 129.8, h: 23 }] },
      { kind: 'before', box: { x: 389, y: 142.6, w: 162.3, h: 32 } },
      { kind: 'before', box: { x: 389, y: 190.6, w: 268.3, h: 19.5 } },
      { kind: 'before', box: { x: 389, y: 232.1, w: 230, h: 56 } },
      { kind: 'before', box: { x: 681, y: 97.6, w: 336, h: 190.5 } }] },
  { name: 'charcoal 1920 1080 stage-ja-long', stage: { x: 0, y: 0, w: 1506.4, h: 356.2 }, pole: { x: 1399.8, y: 85.5 },
    rings: [39.7, 60.2, 81, 93.6, 195.1, 229.5, 280.8, 330.1],
    items: [{ kind: 'etch', box: { x: 1329.7, y: 220.2, w: 140.7, h: 112 } },
      { kind: 'box', box: { x: 30, y: 70.1, w: 216, h: 216 } },
      { kind: 'start', box: { x: 389, y: 24, w: 1073.4, h: 308.2 } },
      { kind: 'box', box: { x: 389, y: 24, w: 142.3, h: 19.5 } },
      { kind: 'text', box: { x: 389, y: 53.5, w: 988, h: 88.2 }, lines: [{ x: 389, y: 53.5, w: 558.8, h: 49 }, { x: 389, y: 91.6, w: 576.3, h: 50.1 }] },
      { kind: 'text', box: { x: 389, y: 148.7, w: 58.3, h: 24 }, lines: [{ x: 389, y: 148.7, w: 58.3, h: 23 }] },
      { kind: 'before', box: { x: 389, y: 186.7, w: 272, h: 32 } },
      { kind: 'before', box: { x: 389, y: 234.7, w: 94.5, h: 19.5 } },
      { kind: 'before', box: { x: 389, y: 276.2, w: 230, h: 56 } },
      { kind: 'before', box: { x: 681, y: 141.7, w: 336, h: 190.5 } }] },
  { name: 'charcoal 2560 1440 stage-short', stage: { x: 0, y: 0, w: 1772, h: 312.1 }, pole: { x: 1665.4, y: 74.9 },
    rings: [39.7, 60.2, 93.6, 195.1, 229.5, 394.1, 468.3, 630],
    items: [{ kind: 'etch', box: { x: 1595.3, y: 176.1, w: 140.7, h: 112 } },
      { kind: 'box', box: { x: 30, y: 48, w: 216, h: 216 } },
      { kind: 'start', box: { x: 389, y: 24, w: 1339, h: 264.1 } },
      { kind: 'box', box: { x: 389, y: 24, w: 142.3, h: 19.5 } },
      { kind: 'text', box: { x: 389, y: 53.5, w: 158.6, h: 44.1 }, lines: [{ x: 389, y: 53.5, w: 158.6, h: 44.1 }] },
      { kind: 'text', box: { x: 389, y: 104.6, w: 129.8, h: 24 }, lines: [{ x: 389, y: 104.6, w: 129.8, h: 23 }] },
      { kind: 'before', box: { x: 389, y: 142.6, w: 162.3, h: 32 } },
      { kind: 'before', box: { x: 389, y: 190.6, w: 268.3, h: 19.5 } },
      { kind: 'before', box: { x: 389, y: 232.1, w: 230, h: 56 } },
      { kind: 'before', box: { x: 681, y: 97.6, w: 336, h: 190.5 } }] },
  { name: 'light 1920 1080 stage-short', stage: { x: 0, y: 0, w: 1506.4, h: 312.1 }, pole: { x: 1399.8, y: 74.9 },
    rings: [39.7, 60.2, 93.6, 195.1, 229.5, 280.8, 330.1],
    items: [{ kind: 'etch', box: { x: 1329.7, y: 176.1, w: 140.7, h: 112 } },
      { kind: 'box', box: { x: 30, y: 48, w: 216, h: 216 } },
      { kind: 'start', box: { x: 389, y: 24, w: 1073.4, h: 264.1 } },
      { kind: 'box', box: { x: 389, y: 24, w: 142.3, h: 19.5 } },
      { kind: 'text', box: { x: 389, y: 53.5, w: 158.6, h: 44.1 }, lines: [{ x: 389, y: 53.5, w: 158.6, h: 44.1 }] },
      { kind: 'text', box: { x: 389, y: 104.6, w: 129.8, h: 24 }, lines: [{ x: 389, y: 104.6, w: 129.8, h: 23 }] },
      { kind: 'before', box: { x: 389, y: 142.6, w: 162.3, h: 32 } },
      { kind: 'before', box: { x: 389, y: 190.6, w: 268.3, h: 19.5 } },
      { kind: 'before', box: { x: 389, y: 232.1, w: 230, h: 56 } },
      { kind: 'before', box: { x: 681, y: 97.6, w: 336, h: 190.5 } }] },
  { name: 'blue 1280 800 stage-short', stage: { x: 0, y: 0, w: 1200, h: 312.1 }, pole: { x: 1093.5, y: 74.9 },
    rings: [39.7, 60.2, 93.6],
    items: [{ kind: 'etch', box: { x: 1023.3, y: 176.1, w: 140.7, h: 112 } },
      { kind: 'box', box: { x: 30, y: 56.8, w: 198.4, h: 198.4 } },
      { kind: 'start', box: { x: 359.2, y: 24, w: 796.8, h: 264.1 } },
      { kind: 'box', box: { x: 359.2, y: 24, w: 142.3, h: 19.5 } },
      { kind: 'text', box: { x: 359.2, y: 53.5, w: 158.6, h: 44.1 }, lines: [{ x: 359.2, y: 53.5, w: 158.6, h: 44.1 }] },
      { kind: 'text', box: { x: 359.2, y: 104.6, w: 129.8, h: 24 }, lines: [{ x: 359.2, y: 104.6, w: 129.8, h: 23 }] },
      { kind: 'before', box: { x: 359.2, y: 142.6, w: 162.3, h: 32 } },
      { kind: 'before', box: { x: 359.2, y: 190.6, w: 268.3, h: 19.5 } },
      { kind: 'before', box: { x: 359.2, y: 232.1, w: 230, h: 56 } },
      { kind: 'before', box: { x: 651.2, y: 97.6, w: 336, h: 190.5 } }] },
  { name: 'charcoal 1360 800 stage-ja-long', stage: { x: 0, y: 0, w: 1252, h: 356.2 }, pole: { x: 1145.5, y: 85.5 },
    rings: [39.7, 60.2, 81, 93.6, 125.6],
    items: [{ kind: 'etch', box: { x: 1075.3, y: 220.2, w: 140.7, h: 112 } },
      { kind: 'box', box: { x: 30, y: 72.7, w: 210.8, h: 210.8 } },
      { kind: 'start', box: { x: 379.8, y: 24, w: 828.2, h: 308.2 } },
      { kind: 'box', box: { x: 379.8, y: 24, w: 142.3, h: 19.5 } },
      { kind: 'text', box: { x: 379.8, y: 53.5, w: 828.2, h: 88.2 }, lines: [{ x: 379.8, y: 53.5, w: 558.8, h: 49 }, { x: 379.8, y: 91.6, w: 576.3, h: 50.1 }] },
      { kind: 'text', box: { x: 379.8, y: 148.7, w: 58.3, h: 24 }, lines: [{ x: 379.8, y: 148.7, w: 58.3, h: 23 }] },
      { kind: 'before', box: { x: 379.8, y: 186.7, w: 272, h: 32 } },
      { kind: 'before', box: { x: 379.8, y: 234.7, w: 94.5, h: 19.5 } },
      { kind: 'before', box: { x: 379.8, y: 276.2, w: 230, h: 56 } },
      { kind: 'before', box: { x: 671.8, y: 141.7, w: 336, h: 190.5 } }] },
  { name: 'charcoal 960 600 stage-ja-long', stage: { x: 0, y: 0, w: 906, h: 191.4 }, pole: { x: 799.5, y: 45.9 },
    rings: [93.6],
    items: [{ kind: 'box', box: { x: 20, y: 33.7, w: 124, h: 124 } },
      { kind: 'start', box: { x: 221.3, y: 16, w: 660.8, h: 159.4 } },
      { kind: 'box', box: { x: 221.3, y: 16, w: 138.3, h: 19.5 } },
      { kind: 'text', box: { x: 221.3, y: 41.5, w: 546, h: 24.4 }, lines: [{ x: 221.3, y: 41.5, w: 514.7, h: 24.4 }, { x: 221.3, y: 62.9, w: 112.5, h: 3 }] },
      { kind: 'text', box: { x: 221.3, y: 68.9, w: 51, h: 21 }, lines: [{ x: 221.3, y: 68.9, w: 51, h: 20 }] },
      { kind: 'before', box: { x: 221.3, y: 97.9, w: 90.5, h: 19.5 } },
      { kind: 'before', box: { x: 221.3, y: 129.4, w: 190, h: 46 } },
      { kind: 'before', box: { x: 501.3, y: 69.9, w: 336, h: 105.5 } }] },
  { name: 'charcoal 1100 720 stage-ja-long', stage: { x: 0, y: 0, w: 1020, h: 349.7 }, pole: { x: 913.5, y: 83.9 },
    rings: [39.7, 60.2, 81, 93.6],
    items: [{ kind: 'etch', box: { x: 843.3, y: 213.7, w: 140.7, h: 112 } },
      { kind: 'box', box: { x: 30, y: 89.6, w: 170.5, h: 170.5 } },
      { kind: 'start', box: { x: 312.9, y: 24, w: 663.1, h: 301.7 } },
      { kind: 'box', box: { x: 312.9, y: 24, w: 142.3, h: 19.5 } },
      { kind: 'text', box: { x: 312.9, y: 53.5, w: 663.1, h: 81.7 }, lines: [{ x: 312.9, y: 53.5, w: 517.4, h: 45 }, { x: 312.9, y: 88.3, w: 533.6, h: 46.8 }] },
      { kind: 'text', box: { x: 312.9, y: 142.2, w: 58.3, h: 24 }, lines: [{ x: 312.9, y: 142.2, w: 58.3, h: 23 }] },
      { kind: 'before', box: { x: 312.9, y: 180.2, w: 272, h: 32 } },
      { kind: 'before', box: { x: 312.9, y: 228.2, w: 94.5, h: 19.5 } },
      { kind: 'before', box: { x: 312.9, y: 269.7, w: 230, h: 56 } },
      { kind: 'before', box: { x: 604.9, y: 135.2, w: 220.4, h: 190.5 } }] },
  { name: 'charcoal 1920 1080 stage-ja-long etch=0', stage: { x: 0, y: 0, w: 1506.4, h: 356.2 }, pole: { x: 1399.8, y: 85.5 },
    rings: [60.2, 81, 93.6, 138.9, 187.1, 229.5, 280.8, 330.1],
    items: [{ kind: 'box', box: { x: 30, y: 70.1, w: 216, h: 216 } },
      { kind: 'start', box: { x: 389, y: 24, w: 1073.4, h: 308.2 } },
      { kind: 'box', box: { x: 389, y: 24, w: 142.3, h: 19.5 } },
      { kind: 'text', box: { x: 389, y: 53.5, w: 988, h: 88.2 }, lines: [{ x: 389, y: 53.5, w: 558.8, h: 49 }, { x: 389, y: 91.6, w: 576.3, h: 50.1 }] },
      { kind: 'text', box: { x: 389, y: 148.7, w: 58.3, h: 24 }, lines: [{ x: 389, y: 148.7, w: 58.3, h: 23 }] },
      { kind: 'before', box: { x: 389, y: 186.7, w: 272, h: 32 } },
      { kind: 'before', box: { x: 389, y: 234.7, w: 94.5, h: 19.5 } },
      { kind: 'before', box: { x: 389, y: 276.2, w: 230, h: 56 } },
      { kind: 'before', box: { x: 681, y: 141.7, w: 336, h: 190.5 } }] },
  { name: 'charcoal 1920 1080 stage-ja-long fs=1.3', stage: { x: 0, y: 0, w: 1506.4, h: 375.1 }, pole: { x: 1399.8, y: 90 },
    rings: [39.7, 60.2, 81, 93.6, 125.6, 195.1, 229.5, 280.8],
    items: [{ kind: 'etch', box: { x: 1329.7, y: 239.1, w: 140.7, h: 112 } },
      { kind: 'box', box: { x: 30, y: 79.5, w: 216, h: 216 } },
      { kind: 'start', box: { x: 389, y: 24, w: 1073.4, h: 327.1 } },
      { kind: 'box', box: { x: 389, y: 24, w: 174.6, h: 25.4 } },
      { kind: 'text', box: { x: 389, y: 59.4, w: 988, h: 88.2 }, lines: [{ x: 389, y: 59.4, w: 558.8, h: 49 }, { x: 389, y: 97.4, w: 576.3, h: 50.1 }] },
      { kind: 'text', box: { x: 389, y: 154.5, w: 75.7, h: 31.2 }, lines: [{ x: 389, y: 154.5, w: 75.7, h: 30 }] },
      { kind: 'before', box: { x: 389, y: 199.7, w: 353.6, h: 32 } },
      { kind: 'before', box: { x: 389, y: 247.7, w: 104.2, h: 25.4 } },
      { kind: 'before', box: { x: 389, y: 295.1, w: 230, h: 56 } },
      { kind: 'before', box: { x: 762.6, y: 147.5, w: 336, h: 203.5 } }] },
  { name: 'charcoal 1440 900 stage-long', stage: { x: 0, y: 0, w: 1252, h: 356.2 }, pole: { x: 1145.5, y: 85.5 },
    rings: [81, 93.6, 125.6],
    items: [{ kind: 'etch', box: { x: 1075.3, y: 220.2, w: 140.7, h: 112 } },
      { kind: 'box', box: { x: 30, y: 70.1, w: 216, h: 216 } },
      { kind: 'start', box: { x: 389, y: 24, w: 819, h: 308.2 } },
      { kind: 'box', box: { x: 389, y: 24, w: 142.3, h: 19.5 } },
      { kind: 'text', box: { x: 389, y: 53.5, w: 819, h: 88.2 }, lines: [{ x: 389, y: 53.5, w: 766.5, h: 49 }, { x: 389, y: 91.6, w: 783.1, h: 50.1 }, { x: 389, y: 135.7, w: 232.4, h: 6 }] },
      { kind: 'text', box: { x: 389, y: 148.7, w: 272, h: 24 }, lines: [{ x: 389, y: 148.7, w: 601.4, h: 23 }, { x: 389, y: 148.7, w: 255.1, h: 23 }] },
      { kind: 'before', box: { x: 389, y: 186.7, w: 272, h: 32 } },
      { kind: 'before', box: { x: 389, y: 234.7, w: 268.3, h: 19.5 } },
      { kind: 'before', box: { x: 389, y: 276.2, w: 230, h: 56 } },
      { kind: 'before', box: { x: 681, y: 141.7, w: 336, h: 190.5 } }] },
  { name: 'charcoal 1280 800 stage-short', stage: { x: 0, y: 0, w: 1200, h: 312.1 }, pole: { x: 1093.5, y: 74.9 },
    rings: [39.7, 60.2, 93.6],
    items: [{ kind: 'etch', box: { x: 1023.3, y: 176.1, w: 140.7, h: 112 } },
      { kind: 'box', box: { x: 30, y: 56.8, w: 198.4, h: 198.4 } },
      { kind: 'start', box: { x: 359.2, y: 24, w: 796.8, h: 264.1 } },
      { kind: 'box', box: { x: 359.2, y: 24, w: 142.3, h: 19.5 } },
      { kind: 'text', box: { x: 359.2, y: 53.5, w: 158.6, h: 44.1 }, lines: [{ x: 359.2, y: 53.5, w: 158.6, h: 44.1 }] },
      { kind: 'text', box: { x: 359.2, y: 104.6, w: 129.8, h: 24 }, lines: [{ x: 359.2, y: 104.6, w: 129.8, h: 23 }] },
      { kind: 'before', box: { x: 359.2, y: 142.6, w: 162.3, h: 32 } },
      { kind: 'before', box: { x: 359.2, y: 190.6, w: 268.3, h: 19.5 } },
      { kind: 'before', box: { x: 359.2, y: 232.1, w: 230, h: 56 } },
      { kind: 'before', box: { x: 651.2, y: 97.6, w: 336, h: 190.5 } }] },
];

/* ── The sky's own seen points, and the light's windows ─────────────── */

const norm = (a: number) => ((a % TURN) + TURN) % TURN;
const inBox = (p: Point, b: Box, pad = 0) => p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
/** What stands in front of the trails: lines of text, boxes, and all of the stage before the text column; the etching's box apart. */
function front(s: Scene): { content: Box[]; etch: Box | null } {
  const content: Box[] = [];
  let etch: Box | null = null;
  for (const { kind, box, lines } of s.items) {
    if (kind === 'text') content.push(...(lines?.length ? lines : [box]));
    else if (kind === 'start') content.push({ x: s.stage.x, y: s.stage.y, w: box.x - s.stage.x, h: s.stage.h });
    else if (kind === 'etch') etch = box;
    else content.push(box);
  }
  return { content, etch };
}
type Why = 'outside' | 'content' | 'memorial' | 'clearance' | null;
/** Why a trail point is not one the light must reach (null: it must). */
function why(s: Scene, p: Point): Why {
  const { stage } = s, { content, etch } = front(s);
  if (p.x < stage.x || p.x > stage.x + stage.w || p.y < stage.y || p.y > stage.y + stage.h) return 'outside';
  if (content.some(b => inBox(p, b))) return 'content';
  if (etch && inBox(p, etch)) return 'memorial';
  if (content.some(b => inBox(p, b, CLEARANCE)) || (etch && inBox(p, etch, ETCH_CLEARANCE))) return 'clearance';
  return null;
}
/** The middle of the cut round the etching (Spotlight.module.css .sky): no trail is seen there, so no light may be. */
function inCut(s: Scene, p: Point, slack = 0): boolean {
  const { etch } = front(s);
  if (!etch) return false;
  const rx = (etch.w / 2 + 28) * 0.62 - slack, ry = (etch.h / 2 + 22) * 0.62 - slack;
  return ((p.x - etch.x - etch.w / 2) / rx) ** 2 + ((p.y - etch.y - etch.h / 2) / ry) ** 2 <= 1;
}
interface Sample { trail: number; angle: number; p: Point; why: Why }
/** Every trail of radius r, a pixel apart with both ends, in order along each trail. */
function samples(s: Scene, r: number): Sample[] {
  return (s.trails ?? TRAILS).flatMap((t, trail) => {
    if (t.r !== r) return [];
    const n = Math.max(2, Math.ceil((t.a1 - t.a0) * t.r));
    return Array.from({ length: n + 1 }, (_, k) => {
      const angle = t.a0 + ((t.a1 - t.a0) * k) / n, p = { x: s.pole.x + r * Math.cos(angle), y: s.pole.y + r * Math.sin(angle) };
      return { trail, angle, p, why: why(s, p) };
    });
  });
}
/** The windows the light's clip path draws, as [low, high] angles: each subpath's outer arc, travelled anticlockwise. */
function clipWindows(pole: Point, arc: LightArc): [number, number][] {
  return [...lightClipPath(pole, arc).matchAll(/M(-?[\d.]+) (-?[\d.]+)A[\d.]+ [\d.]+ 0 ([01]) 0 (-?[\d.]+) (-?[\d.]+)/g)].map(m => {
    const hi = Math.atan2(+m[2] - pole.y, +m[1] - pole.x), lo = Math.atan2(+m[5] - pole.y, +m[4] - pole.x);
    return [lo, lo + norm(hi - lo)];
  });
}
const inWindows = (windows: [number, number][], angle: number) => windows.some(([lo, hi]) => norm(angle - lo) <= hi - lo + 1e-9);

interface Coverage { lights: number; target: number; lit: number; dark: Sample[]; clearance: number; content: number; memorial: number; outside: number; stray: string[] }
/** Every lit ring on a stage: which of its seen points the light reaches, and anywhere it shows that it should not. */
function coverage(s: Scene, arcs = chooseLightArcs(s.trails ?? TRAILS, s.pole, s.stage, s.items)): Coverage {
  const out: Coverage = { lights: arcs.length, target: 0, lit: 0, dark: [], clearance: 0, content: 0, memorial: 0, outside: 0, stray: [] };
  const { content } = front(s);
  for (const arc of arcs) {
    const windows = clipWindows(s.pole, arc);
    for (const x of samples(s, arc.r)) {
      if (x.why) { out[x.why]++; continue; }
      out.target++;
      if (inWindows(windows, x.angle)) out.lit++; else out.dark.push(x);
    }
    // The clip on the ring, a pixel apart: on an etched trail of the ring, in the stage, clear of the content and out of the cut's middle.
    for (const [lo, hi] of windows) {
      const n = Math.max(2, Math.ceil((hi - lo) * arc.r));
      for (let k = 0; k <= n; k++) {
        const a = lo + ((hi - lo) * k) / n, p = { x: s.pole.x + arc.r * Math.cos(a), y: s.pole.y + arc.r * Math.sin(a) };
        const at = `r=${arc.r} at ${p.x.toFixed(1)},${p.y.toFixed(1)}`;
        if (!(s.trails ?? TRAILS).some(t => t.r === arc.r && norm(a - t.a0 + 0.5 / arc.r) <= t.a1 - t.a0 + 1 / arc.r)) out.stray.push(`no trail: ${at}`);
        if (!inBox(p, s.stage, 0.5)) out.stray.push(`outside the stage: ${at}`);
        if (content.some(b => inBox(p, b, CLEARANCE - 0.5))) out.stray.push(`over content: ${at}`);
        if (inCut(s, p, 0.5)) out.stray.push(`in the cut's middle: ${at}`);
      }
    }
  }
  return out;
}
const where = (c: Coverage) => c.dark.slice(0, 6).map(d => `trail ${d.trail} at ${d.p.x.toFixed(0)},${d.p.y.toFixed(0)}`).join('; ');

/* ── The motion, as the stylesheet runs it ────────────────────────── */

/** The animation's progress at time u (0…1) from the schedule's linear() easing. */
function easing(text: string): (u: number) => number {
  if (text === 'linear') return u => u;
  const stops = text.slice(7, -1).split(',').map(s => s.trim().split(/\s+/)).map(([p, t]) => [parseFloat(t) / 100, Number(p)] as const);
  return u => {
    for (let i = 1; i < stops.length; i++) if (u <= stops[i][0]) {
      const [t0, p0] = stops[i - 1], [t1, p1] = stops[i];
      return t1 > t0 ? p0 + ((p1 - p0) * (u - t0)) / (t1 - t0) : p1;
    }
    return 1;
  };
}
/**
 * One cycle of a light in `steps`: the head's angle, whether any of the light (its glow ahead of
 * the head to the seen part of its tail) is in a window, and its speed then (px per ms).
 */
function motion(s: Scene, arc: LightArc, steps = 8000) {
  const sched = lightSchedule(arc), m = lightMeteor(arc), ease = easing(sched.easing), windows = clipWindows(s.pole, arc);
  const rad = Math.PI / 180, F = sched.from * rad, T = sched.to * rad;
  const head = (u: number) => F + (T - F) * ease(u);
  const ahead = (GLOW.along - GLOW.back) / arc.r, behind = m.angle * 0.92;
  const shown = (h: number) => windows.some(([lo, hi]) => {
    // The light covers [h - ahead, h + behind]; a window [lo, hi] meets it when they overlap round the circle.
    const a = norm(h - ahead - lo);
    return a <= hi - lo || a + ahead + behind >= TURN;
  });
  const frames = Array.from({ length: steps + 1 }, (_, i) => {
    const u = i / steps, h = head(u);
    return { u, head: h, shown: shown(h), speed: (Math.abs(head(Math.min(1, u + 1e-6)) - head(Math.max(0, u - 1e-6))) * arc.r) / (2e-6 * sched.ms) };
  });
  return { sched, frames, F, T };
}

/* ── Coverage ─────────────────────────────────────────────────────── */

describe('every stretch of a lit ring that is seen gets the light', () => {
  const plain: Box = { x: 0, y: 0, w: 1000, h: 600 }, centre = { x: 500, y: 300 };

  test('a trail cut in two by something in front of it: both sides light, the content and its clearance stay dark', () => {
    const s: Scene = { name: 'split', stage: plain, pole: centre, trails: [{ r: 180, a0: 0.1, a1: 3.04 }], items: [{ kind: 'box', box: { x: 485, y: 455, w: 30, h: 40 } }] };
    const c = coverage(s);
    expect(c.lights).toBe(1);
    expect(c.dark.length, where(c)).toBe(0);
    expect(c.stray).toEqual([]);
    expect(c.content).toBeGreaterThan(0);
    expect(c.clearance).toBeGreaterThan(0);
    const [arc] = chooseLightArcs(s.trails!, s.pole, s.stage, s.items);
    expect(clipWindows(s.pole, arc)).toHaveLength(2);
  });

  test('two trails of the same radius: one light, through both', () => {
    const s: Scene = { name: 'twins', stage: plain, pole: centre, trails: [{ r: 180, a0: 0.1, a1: 0.9 }, { r: 180, a0: 2.2, a1: 2.8 }], items: [] };
    const c = coverage(s);
    expect(c.lights).toBe(1);
    expect(c.target).toBeGreaterThan(250);
    expect(c.dark.length, where(c)).toBe(0);
  });

  test('the stage edge is the end: a trail runs on to the edge itself, out past it and back in, and into the rounded corners', () => {
    const stage = { x: 0, y: 0, w: 1654, h: 312.1 }, pole = { x: 1547.4, y: 74.9 }, field: KeepItem = { kind: 'before', box: { x: 681, y: 97.6, w: 336, h: 190.5 } };
    for (const trails of [
      [{ r: 394.1, a0: 3.0, a1: 4.3 }],                           // up to the top edge (the user's A)
      [{ r: 195.1, a0: 2.9, a1: 3.6 }],                           // up to the top edge (B)
      [{ r: 93.6, a0: -0.37, a1: 0.91 }],                         // along the right edge, inside round 2's 14px (C)
      [{ r: 468.3, a0: 2.5, a1: 3.0 }],                           // down to the bottom edge, right of the music field (D)
      [{ r: 125.6, a0: 1.0, a1: 2.6 }, { r: 125.6, a0: 3.75, a1: 3.85 }],  // and a twin dipping 4px into the glass at the top edge
      [{ r: 60.2, a0: 4.0, a1: 5.2 }, { r: 60.2, a0: 5.25, a1: 5.27 }],  // a sliver of 1.2px past a short gap
    ]) {
      const s: Scene = { name: 'edge', stage, pole, trails, items: [field] };
      const c = coverage(s);
      expect(c.lights, JSON.stringify(trails)).toBe(1);
      expect(c.dark.length, `${JSON.stringify(trails)}: ${where(c)}`).toBe(0);
      expect(c.stray).toEqual([]);
    }
    // The ends at the edge: the clip reaches the edge itself (to a pixel), not 14px short of it.
    const [arc] = chooseLightArcs([{ r: 394.1, a0: 3.0, a1: 4.3 }], pole, stage, [field]);
    const top = Math.min(...arc.windows.map(w => [w.from, w.to]).flat().map(a => pole.y + 394.1 * Math.sin(a)));
    expect(top).toBeLessThan(1);
  });

  test('a lone sliver far from the rest of its ring is lit, and gets the head', () => {
    const base: Scene = { name: 'far', stage: { x: 0, y: 0, w: 1000, h: 600 }, pole: { x: 500, y: 300 }, items: [] };
    for (const len of [1, 3, 6, 11]) {
      const s = { ...base, trails: [{ r: 200, a0: 0.2, a1: 1.2 }, { r: 200, a0: 3.0, a1: 3.0 + len / 200 }] };
      const [arc] = chooseLightArcs(s.trails, s.pole, s.stage, s.items);
      expect(arc.windows.map(w => w.index).sort()).toEqual([0, 1]);
      const c = coverage(s);
      expect(c.dark.length, where(c)).toBe(0);
      // While the head crosses the sliver, the light moves at its even pace (it is seen), not in a quick crossing.
      const { frames, sched } = motion(s, arc);
      const over = frames.filter(f => norm(f.head - 3.0) <= len / 200);
      expect(over.length).toBeGreaterThan(0);
      for (const f of over) { expect(f.shown).toBe(true); expect(f.speed).toBeLessThan(sched.pace * 1.02); }
    }
    expect('MIN_SLIVER' in light).toBe(false);
  });

  test('round the memorial etching: dark only in the middle of the cut; its fading rim, under the caption, carries light', () => {
    const stage = { x: 0, y: 0, w: 1654, h: 312.1 }, pole = { x: 1547.4, y: 74.9 };
    const etch: KeepItem = { kind: 'etch', box: { x: 1477.3, y: 176.1, w: 140.7, h: 112 } };
    // Ring 229.5 under the etching (the user's E): round 2 and 3 kept the whole oval and 14px more dark.
    const s: Scene = { name: 'under', stage, pole, trails: [{ r: 229.5, a0: 0.9, a1: 2.3 }], items: [etch] };
    const c = coverage(s);
    expect(c.lights).toBe(1);
    expect(c.dark.length, where(c)).toBe(0);
    expect(c.stray).toEqual([]);
    const [arc] = chooseLightArcs(s.trails!, pole, stage, s.items);
    const lowest = Math.max(...samples(s, 229.5).filter(x => inWindows(clipWindows(pole, arc), x.angle)).map(x => x.p.y));
    expect(lowest).toBeGreaterThan(300);   // the arc's foot under the etching, 12px above the stage's bottom edge
    // A ring through the middle of the cut: nothing there, light either side.
    const through: Scene = { name: 'through', stage, pole: { x: 1400, y: 132 }, trails: [{ r: 100, a0: -0.5, a1: 2.7 }],
      items: [{ kind: 'etch', box: { x: 1329.65, y: 176.1, w: 140.7, h: 112 } }] };
    const t = coverage(through);
    expect(t.lights).toBe(1);
    expect(t.stray).toEqual([]);
    expect(t.dark.length, where(t)).toBe(0);
  });

  test.each(STAGES.map(s => [s.name, s] as const))('the real sky, %s: every seen point of every lit ring is in its light; the light shows nowhere else', (_, s) => {
    const c = coverage(s);
    expect(c.lights).toBe(s.rings!.length);
    expect(c.dark.length, where(c)).toBe(0);
    expect(c.stray.slice(0, 3)).toEqual([]);
    expect(c.lit).toBe(c.target);
  });
});

/* ── The run round a ring, and the motion ─────────────────────────── */

describe('a light turns once round all of its ring each cycle', () => {
  test('the same rings as before; its windows in order and on its own trails; its main stretch among them', () => {
    for (const s of STAGES) {
      const arcs = chooseLightArcs(TRAILS, s.pole, s.stage, s.items);
      expect(arcs.map(a => a.r), s.name).toEqual(s.rings);
      for (const arc of arcs) {
        expect(arc.windows.some(w => w.index === arc.index && Math.abs(w.from - arc.from) < 1e-9 && Math.abs(w.to - arc.to) < 1e-9)).toBe(true);
        arc.windows.forEach((w, i) => {
          expect(w.from).toBeLessThanOrEqual(arc.start + 1e-9); expect(w.to).toBeGreaterThanOrEqual(arc.end - 1e-9);
          expect(w.length).toBeCloseTo((w.from - w.to) * arc.r, 6);
          if (i) expect(w.from).toBeLessThanOrEqual(arc.windows[i - 1].from);
          const t = TRAILS[w.index];
          expect(t.r).toBe(arc.r);
          expect(norm(w.to - t.a0)).toBeLessThanOrEqual(t.a1 - t.a0 + 1e-9);
          expect(norm(w.to - t.a0) + (w.from - w.to)).toBeLessThanOrEqual(t.a1 - t.a0 + 1e-9);
        });
        expect(Math.max(...arc.windows.map(w => w.from))).toBeCloseTo(arc.start, 9);
        expect(Math.min(...arc.windows.map(w => w.to))).toBeCloseTo(arc.end, 9);
        expect(lightPath(s.pole, arc).match(/M/g)).toHaveLength(arc.windows.length);
      }
    }
  });

  test.each(STAGES.map(s => [s.name, s] as const))('%s: one whole turn, even wherever it is seen, a short crossing wherever not; the head passes every seen point', (_, s) => {
    for (const arc of chooseLightArcs(TRAILS, s.pole, s.stage, s.items)) {
      const { sched, frames, F, T } = motion(s, arc);
      // A whole turn, the angle falling: the loop ends where it began.
      expect(T - F).toBeCloseTo(-TURN, 9);
      // Even while seen.
      const seen = frames.filter(f => f.shown);
      for (const f of seen) expect(Math.abs(f.speed - sched.pace) / sched.pace, `r=${arc.r} at ${f.u}`).toBeLessThan(0.02);
      // Never long unseen: each run of frames with nothing in a window lasts at most TRANSIT_MS (the cycle's ends are one run).
      let run = 0, longest = 0;
      for (const f of [...frames, ...frames]) { run = f.shown ? 0 : run + 1; longest = Math.max(longest, run); }
      // (to a frame, and the pixel or so by which the lib's windows reach past the drawn light at each end)
      expect((Math.min(longest, frames.length) / (frames.length - 1)) * sched.ms, `r=${arc.r}`).toBeLessThanOrEqual(TRANSIT_MS + (2 * sched.ms) / 8000 + 1.5 / sched.pace);
      expect(Math.max(0, ...sched.transits)).toBeLessThanOrEqual(TRANSIT_MS + 1e-6);
      // The cycle starts unseen (in its widest crossing), unless some of the light is always seen.
      if (sched.transits.length) expect(frames[0].shown).toBe(false);
      // Every point of the clip is passed by the head while the light is seen (at its even pace, not in a crossing).
      for (const [lo, hi] of clipWindows(s.pole, arc)) for (const a of [lo + 0.2 / arc.r, (lo + hi) / 2, hi - 0.2 / arc.r]) {
        const near = frames.filter(f => Math.abs(norm(f.head - a + Math.PI) - Math.PI) * arc.r < 3);
        expect(near.length, `r=${arc.r} at ${a}`).toBeGreaterThan(0);
        expect(near.every(f => f.shown)).toBe(true);
      }
    }
  });

  test('a light with more of its ring to cover keeps its pace: the extra stretches add time, not speed', () => {
    for (const s of STAGES) for (const arc of chooseLightArcs(TRAILS, s.pole, s.stage, s.items)) {
      const alone: LightArc = { ...arc, start: arc.from, end: arc.to, windows: [arc] };
      const a = lightSchedule(arc), b = lightSchedule(alone);
      expect(a.pace).toBeCloseTo(b.pace, 9);
      expect(a.ms).toBeGreaterThanOrEqual(b.ms - 1e-6);
      // The main stretch and the tail take 9 to 24 s at that pace.
      const own = arc.length + lightMeteor(arc).length + 2.8 * 2;
      expect(own / a.pace).toBeGreaterThanOrEqual(9000 - 1); expect(own / a.pace).toBeLessThanOrEqual(24000 + 1);
    }
  });
});

/* ── Colour and the drawn light ─────────────────────────────────────── */

describe('the light takes the music field\'s colours', () => {
  const css = read('src/ui/views/Spotlight.module.css');
  test('tail the bars\' accent, head the peaks\' colour with a moderate white, glow the accent\'s light tint; nothing fixed', () => {
    const decls = [...css.matchAll(/(--flow-[a-z]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]);
    expect(decls).toEqual([
      ['--flow-body', 'var(--accent-fill)'], ['--flow-head', 'color-mix(in srgb, var(--viz-arc) 75%, #fff)'], ['--flow-glow', 'var(--accent-hi)'],
      ['--flow-head', 'var(--viz-arc)'],   // charcoal: the peaks' own light ink, already a moderate white
    ]);
    const charcoal = css.match(/:global\(\.cdp\[data-theme="charcoal"\]\) \.stage \{([^}]*)\}/)![1];
    expect(charcoal).toContain('--viz-arc: var(--accent-ink);');
    expect(charcoal).toContain('--flow-head: var(--viz-arc);');
    // The peaks are drawn in --viz-arc (AttentionField.module.css), the bars in the accent.
    const field = read('src/ui/components/AttentionField.module.css');
    expect(field).toMatch(/\.peak \{ fill: var\(--viz-arc/); expect(field).toMatch(/\.bar \{ stroke: var\(--accent-fill\)/);
    const own = read('src/ui/components/TrailLight.module.css').replace(/\/\*[\s\S]*?\*\//g, '') + read('src/ui/components/TrailLight.tsx');
    expect(own).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
    expect([...read('src/ui/components/TrailLight.tsx').matchAll(/stopColor="([^"]+)"/g)].map(m => m[1]).sort())
      .toEqual(['var(--flow-body)', 'var(--flow-body)', 'var(--flow-glow)', 'var(--flow-glow)', 'var(--flow-glow)', 'var(--flow-head)']);
  });
});

let session: ReturnType<typeof createMockSession> | null = null;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); session?.destroy(); session = null; });
async function playing(): Promise<UISnapshot> {
  session = createMockSession({ autoTick: false });
  const bridge = session.connect('main');
  await act(async () => { await bridge.dispatch({ type: 'playAlbum', albumId: 'album-blue' }); });
  return bridge.getSnapshot();
}
const onAction = async (_a: UIAction): Promise<ActionResult> => ({ ok: true, status: 'applied' });

describe('the drawn light: one shape per lit ring, marked for checks from outside', () => {
  test('each light names its ring and every window it shows in; one route, one clip, one gradient, one meteor with its glow', async () => {
    // The 2100×900 stage (short title), laid out for jsdom from its measured boxes (text: no line boxes here).
    const s = STAGES[0];
    const rect = (b: Box) => ({ x: b.x, y: b.y, left: b.x, top: b.y, width: b.w, height: b.h, right: b.x + b.w, bottom: b.y + b.h, toJSON() { return this; } }) as DOMRect;
    const boxes: Record<string, Box> = Object.fromEntries(s.items.filter(i => i.kind !== 'box').map(i => [i.kind, i.box]));
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.matches('section[data-viz]')) return rect(s.stage);
      if (this.matches('[data-etch="star-trails"] svg')) return rect({ x: s.pole.x - TRAILS_BOX.cx, y: s.pole.y - TRAILS_BOX.cy, w: TRAILS_BOX.w, h: TRAILS_BOX.h });
      const kind = (this as HTMLElement).dataset?.keepClear;
      if (kind !== undefined) return rect(boxes[kind] ?? { x: 30, y: 48, w: 216, h: 216 });
      return rect({ x: 0, y: 0, w: 0, h: 0 });
    });
    render(<UIBootContext.Provider value={{}}><PlayerUI snapshot={await playing()} surface="main" onAction={onAction} /></UIBootContext.Provider>);
    const root = document.querySelector<SVGSVGElement>('[data-ambient="stage"]')!;
    const lights = [...root.querySelectorAll<SVGGElement>('g[data-trail]')];
    expect(lights.length).toBeGreaterThanOrEqual(5);
    expect(lights.length).toBeLessThanOrEqual(8);
    expect(root.dataset.lights).toBe(String(lights.length));
    expect(root.querySelectorAll('radialGradient')).toHaveLength(1);   // one glow for every head
    let windows = 0;
    for (const g of lights) {
      const ring = Number(g.dataset.ring), list = g.dataset.windows!.split(' ').map(w => w.split(':').map(Number));
      expect(list.length).toBeGreaterThan(0);
      for (const [index, to, from] of list) { expect(TRAILS[index].r).toBe(ring); expect(from).toBeGreaterThan(to); }
      expect(list.some(([index]) => index === Number(g.dataset.trail))).toBe(true);
      windows += list.length;
      expect(g.querySelectorAll('[data-light-path]')).toHaveLength(1);
      expect(g.querySelector('[data-light-path]')!.getAttribute('d')!.match(/M/g)).toHaveLength(list.length);
      expect(g.querySelectorAll('clipPath path')).toHaveLength(1);
      expect(g.querySelectorAll('linearGradient')).toHaveLength(1);
      expect([...g.querySelectorAll('linearGradient stop')].map(x => [x.getAttribute('offset'), x.getAttribute('stop-color'), x.getAttribute('stop-opacity')]))
        .toEqual([['0', 'var(--flow-body)', '0'], ['0.8', 'var(--flow-body)', '0.8'], ['1', 'var(--flow-head)', '1']]);
      expect(g.querySelectorAll('[data-meteor]')).toHaveLength(1);
      expect(g.querySelectorAll('[data-meteor] path')).toHaveLength(1);
      const glow = g.querySelector('[data-meteor] [data-glow]')!;
      expect(glow.getAttribute('fill')).toBe(`url(#${root.querySelector('radialGradient')!.id})`);
      expect([glow.getAttribute('rx'), glow.getAttribute('ry')].map(Number)).toEqual([GLOW.across, GLOW.along]);
      // The glow is drawn under the ribbon, inside the same clip.
      expect(glow.nextElementSibling).toBe(g.querySelector('[data-meteor] path'));
    }
    expect(windows).toBeGreaterThan(lights.length);
    expect(root.querySelectorAll('*').length).toBeLessThanOrEqual(7 + lights.length * 14);
  });
});
