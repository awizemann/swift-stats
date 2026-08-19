// The backend's version is written in two places that must agree: this
// package's `package.json` and the newest `backend-cloudflare-<version>`
// release heading in the repo CHANGELOG. They drifted once — the repo tagged
// v0.2.0 while package.json still said 0.1.0, and the next release had to skip
// a number to get back ahead of the tags. This test is the guard: a release
// that bumps one without the other fails the same suite the release checklist
// already requires to be green.
//
// Both values are read on the Node side in vitest.config.ts (workerd has no
// filesystem) and arrive here as bindings — the same route the migrations take.
// Deliberately files, not git tags: tags are absent in shallow clones.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const { PACKAGE_VERSION, CHANGELOG_MD } = env as unknown as {
  PACKAGE_VERSION: string;
  CHANGELOG_MD: string;
};

describe('release bookkeeping', () => {
  it('package.json matches the newest backend release heading in the CHANGELOG', () => {
    const headings = [...CHANGELOG_MD.matchAll(/^## \[backend-cloudflare-(\d+\.\d+\.\d+)\]/gm)].map(
      (m) => m[1],
    );
    expect(headings.length, 'no backend-cloudflare release heading in CHANGELOG').toBeGreaterThan(0);
    // Headings are newest-first in Keep a Changelog order.
    expect(PACKAGE_VERSION).toBe(headings[0]);
  });
});
