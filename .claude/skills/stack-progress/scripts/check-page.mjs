#!/usr/bin/env node
// Renders the page the way a reader will see it and reports layout faults that
// are easy to miss in hand-written SVG: labels that collide, labels that spill
// out of their box, and pages that scroll sideways on a phone.
//
//   node check-page.mjs page.html [out-dir]
//
// Writes desktop/phone screenshots in light and dark, plus one per diagram, to
// out-dir (default: next to the page), and exits non-zero when it finds a fault.
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const page = resolve(process.argv[2]);
const outDir = resolve(process.argv[3] ?? dirname(page));
const views = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];

const browser = await chromium.launch();
let faults = 0;
for (const scheme of ['light', 'dark']) {
  for (const view of views) {
    const context = await browser.newContext({
      viewport: { width: view.width, height: view.height },
      colorScheme: scheme,
    });
    const tab = await context.newPage();
    const errors = [];
    tab.on('pageerror', (error) => errors.push(error.message));
    await tab.goto(pathToFileURL(page).href, { waitUntil: 'networkidle' });
    const report = await tab.evaluate(() => {
      const found = [];
      const doc = document.documentElement;
      if (doc.scrollWidth > window.innerWidth + 1) {
        found.push(
          `page scrolls sideways: ${doc.scrollWidth}px > ${window.innerWidth}px`,
        );
      }
      document.querySelectorAll('svg').forEach((svg, index) => {
        const label =
          svg.getAttribute('aria-label')?.slice(0, 40) ?? `svg #${index}`;
        const texts = [...svg.querySelectorAll('text')].map((el) => ({
          el,
          box: el.getBBox(),
          text: el.textContent.trim(),
        }));
        const rects = [...svg.querySelectorAll('rect')]
          .map((el) => el.getBBox())
          .filter((box) => box.width < 400 && box.height < 200);
        // Font boxes include ascent and descent, so stacked lines touch;
        // only count a collision when they share a third of the smaller box.
        const overlaps = (a, b) => {
          const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
          const h =
            Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
          const smaller = Math.min(a.width * a.height, b.width * b.height);
          return w > 0 && h > 0 && w * h > smaller / 3;
        };
        for (let i = 0; i < texts.length; i += 1) {
          for (let j = i + 1; j < texts.length; j += 1) {
            if (overlaps(texts[i].box, texts[j].box)) {
              found.push(
                `${label}: "${texts[i].text}" overlaps "${texts[j].text}"`,
              );
            }
          }
          // A label whose centre sits in a box must fit inside it.
          const { box, text } = texts[i];
          const cx = box.x + box.width / 2;
          const cy = box.y + box.height / 2;
          for (const rect of rects) {
            const inside =
              cx > rect.x &&
              cx < rect.x + rect.width &&
              cy > rect.y &&
              cy < rect.y + rect.height;
            if (
              inside &&
              (box.x < rect.x - 1 ||
                box.x + box.width > rect.x + rect.width + 1)
            ) {
              found.push(`${label}: "${text}" spills out of its box`);
            }
          }
        }
      });
      return found;
    });
    const shot = join(outDir, `check-${view.name}-${scheme}.png`);
    await tab.screenshot({ path: shot, fullPage: true });
    if (view.name === 'desktop') {
      // A full page shrinks to illegible when viewed; diagrams get their own shots.
      const figures = await tab.locator('.diagram').all();
      for (const [index, figure] of figures.entries()) {
        await figure.screenshot({
          path: join(outDir, `check-diagram-${index + 1}-${scheme}.png`),
        });
      }
    }
    // Layout faults don't depend on the colour scheme; report them once.
    const unique = scheme === 'light' ? report : [];
    for (const line of [...unique, ...errors]) {
      console.log(`[${view.name}] ${line}`);
      faults += 1;
    }
    console.log(`wrote ${shot}`);
    await context.close();
  }
}
await browser.close();
console.log(faults ? `${faults} fault(s)` : 'no faults');
process.exitCode = faults ? 1 : 0;
