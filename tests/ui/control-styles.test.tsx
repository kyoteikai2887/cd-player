import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/*
 * Regression guard (R1.1 review): the album tile's quick-play button is a .cdp-play positioned by
 * a CSS Module class. A shared rule `.cdp .cdp-play { position: relative }` (specificity 0,2,0)
 * silently beat the module's `position: absolute` (0,1,0) and the button fell out of the cover,
 * under the next row. Shared controls must leave position and transform to the modules.
 */
// Vitest/jsdom may rewrite asset URLs to http://localhost; use the configured project root.
const file = resolve('src/ui/styles/components.css');
const css = readFileSync(file, 'utf8');

function rules(source: string) {
  const out: { selector: string; body: string }[] = [];
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(clean))) out.push({ selector: match[1].trim(), body: match[2] });
  return out;
}

describe('shared control styles leave layout to the views', () => {
  // Rules whose subject is the control itself (not an icon inside it, not a pseudo-element).
  const subject = /^\.cdp \.cdp-(btn|icon-btn|play|chip)[\w-]*(\[[^\]]*\]|:[\w-]+(\([^)]*\))?)*$/;
  const shared = rules(css).filter(rule => rule.selector.split(',').some(sel => subject.test(sel.trim())));

  test('the stylesheet has the shared control rules this guard is about', () => {
    expect(shared.length).toBeGreaterThan(10);
  });
  test('no shared control rule sets position', () => {
    const offenders = shared.filter(rule => /(^|;|\s)position\s*:/.test(rule.body)).map(rule => rule.selector);
    expect(offenders).toEqual([]);
  });
  test('motion uses translate/scale, never transform, so a module can still transform the control', () => {
    const offenders = shared.filter(rule => /(^|;|\s)transform\s*:/.test(rule.body)).map(rule => rule.selector);
    expect(offenders).toEqual([]);
  });
  test('position: relative for controls is declared at zero specificity', () => {
    expect(/:where\(\.cdp\) :where\(\.cdp-btn, \.cdp-icon-btn, \.cdp-play, \.cdp-chip\) \{ position: relative; \}/.test(css)).toBe(true);
  });
});
