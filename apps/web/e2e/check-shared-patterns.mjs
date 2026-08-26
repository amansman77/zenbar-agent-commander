#!/usr/bin/env node
// Reusable Playwright check for the app's small set of shared, class-based
// visual patterns (currently just .icon-button, the circular icon-only
// button shape shared by the header notification toggle and a conversation
// row's delete button -- see base.css for why it exists as a base class
// rather than two independently-written ones).
//
// Two things this does that a screenshot alone or a unit test alone can't:
//   1. Reads real computed styles off whatever's currently rendered and
//      asserts every .icon-button instance agrees on the shared geometry
//      properties -- catches drift structurally (an instance losing the
//      class, or something overriding it) rather than needing a human to
//      notice a few px of difference in a screenshot.
//   2. Screenshots the real instances together, so re-running this later
//      answers "does it still actually look like this?" without having to
//      go find each one by hand in the running app.
//
// Drives the real dev server with whatever data is actually in the DB
// (unlike check-list-overlap.mjs, nothing here is mocked) -- shared button
// chrome doesn't depend on specific content the way row-overlap does, and
// this needs a real conversation/notification-bell pair to exist on
// screen, which is simplest to get from the app's own current state. See
// README.md for why these are plain scripts, not vitest/CI tests.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const WEB_URL = process.env.WEB_URL || "http://127.0.0.1:15173";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "screenshots");
mkdirSync(OUT_DIR, { recursive: true });

// Properties .icon-button itself declares (base.css) -- these are exactly
// what every instance must agree on regardless of its own modifier class's
// size/color/border, which are expected to differ.
const SHARED_PROPS = ["padding", "borderRadius", "display", "alignItems", "justifyContent"];

async function collectIconButtons(page) {
  return page.evaluate((props) => {
    const els = Array.from(document.querySelectorAll(".icon-button"));
    return els.map((el) => {
      const cs = getComputedStyle(el);
      const styles = {};
      for (const p of props) styles[p] = cs[p];
      return {
        label: el.getAttribute("aria-label") || el.className,
        styles,
      };
    });
  }, SHARED_PROPS);
}

function reportGeometryDrift(instances) {
  if (instances.length < 2) {
    console.log(`  SKIP -- only ${instances.length} .icon-button instance(s) on screen, nothing to compare`);
    return [];
  }
  const [reference, ...rest] = instances;
  const failures = [];
  for (const other of rest) {
    for (const prop of SHARED_PROPS) {
      if (reference.styles[prop] !== other.styles[prop]) {
        failures.push({
          prop,
          expected: reference.styles[prop],
          actual: other.styles[prop],
          reference: reference.label,
          instance: other.label,
        });
      }
    }
  }
  if (failures.length === 0) {
    console.log(`  PASS -- ${instances.length} .icon-button instance(s) agree on shared geometry`);
  } else {
    console.log(`  FAIL -- geometry drift between .icon-button instances`);
    for (const f of failures) {
      console.log(
        `    "${f.instance}".${f.prop} = ${f.actual} (expected ${f.expected}, from "${f.reference}")`
      );
    }
  }
  return failures;
}

async function main() {
  const browser = await chromium.launch();
  let allFailures = [];

  // Desktop: header bell (past the divider, end of header-actions) + a
  // conversation row's corner delete button, both on screen together.
  {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    await page.goto(WEB_URL, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(600);

    console.log("--- Desktop: header bell + conversation delete button ---");
    const instances = await collectIconButtons(page);
    allFailures = allFailures.concat(reportGeometryDrift(instances));

    const shotPath = path.join(OUT_DIR, "icon-buttons-desktop.png");
    await page.screenshot({ path: shotPath });
    console.log(`  screenshot: ${shotPath}`);
    await context.close();
  }

  // Mobile: same pattern, different layout position for the bell (paired
  // with the eyebrow label instead of the header-actions row).
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(WEB_URL, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(600);

    console.log("--- Mobile: header bell + conversation delete button ---");
    const instances = await collectIconButtons(page);
    allFailures = allFailures.concat(reportGeometryDrift(instances));

    const shotPath = path.join(OUT_DIR, "icon-buttons-mobile.png");
    await page.screenshot({ path: shotPath });
    console.log(`  screenshot: ${shotPath}`);
    await context.close();
  }

  await browser.close();

  if (allFailures.length > 0) {
    console.log(`\n${allFailures.length} failure(s) total.`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main().catch((err) => {
  console.error("Check script crashed:", err);
  process.exit(1);
});
