#!/usr/bin/env node
/**
 * Renders the README banner and the social preview from the HTML beside this
 * file, with Playwright's Chromium:
 *
 *   assets/header.png          2400 by 600 (1200 by 300 at 2x), for an ~880px README column
 *   assets/social-preview.png  1280 by 640, GitHub's social preview size
 *
 * The fonts load from Google Fonts. The render fails rather than fall back to a
 * system font, so a PNG never ships in the wrong face.
 */
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..');

const jobs = [
  { page: 'header.html', file: 'header.png', width: 1200, height: 300, scale: 2, transparent: true },
  { page: 'social-preview.html', file: 'social-preview.png', width: 1280, height: 640, scale: 1, transparent: false },
];

const FACES = ['600 44px "Fraunces"', '400 20px "Inter"', '400 20px "JetBrains Mono"', '500 20px "JetBrains Mono"'];

const browser = await chromium.launch();
try {
  for (const job of jobs) {
    const page = await browser.newPage({
      viewport: { width: job.width, height: job.height },
      deviceScaleFactor: job.scale,
    });
    await page.goto(pathToFileURL(join(here, job.page)).href, { waitUntil: 'networkidle' });
    await page.evaluate(async faces => {
      await Promise.all(faces.map(f => document.fonts.load(f)));
      await document.fonts.ready;
    }, FACES);
    const missing = await page.evaluate(faces => faces.filter(f => !document.fonts.check(f)), FACES);
    if (missing.length) throw new Error(`${job.page}: fonts did not load: ${missing.join(', ')}`);
    const loaded = await page.evaluate(() => [...document.fonts].filter(f => f.status === 'loaded').map(f => `${f.family} ${f.weight}`));
    await page.locator('.canvas').screenshot({ path: join(out, job.file), omitBackground: job.transparent });
    console.log(`${job.file}: ${job.width * job.scale}x${job.height * job.scale}, fonts ${[...new Set(loaded)].join(', ')}`);
    await page.close();
  }
} finally {
  await browser.close();
}
