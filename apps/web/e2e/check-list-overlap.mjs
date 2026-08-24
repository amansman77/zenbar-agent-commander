#!/usr/bin/env node
// Reusable Playwright smoke check: opens a shared .list-item/.task-row
// surface with deliberately long/edge-case content and asserts every
// action button inside each row still resolves to itself via
// elementFromPoint -- the exact invariant that would have caught
// .list-item losing flex-shrink and letting a row's overflow bleed into
// (and eat clicks for) the next one. See README.md in this directory for
// why this exists as a standalone script rather than a vitest/CI test.

import { chromium } from "playwright";

const WEB_URL = process.env.WEB_URL || "http://127.0.0.1:15173";
const surface = (process.argv.find((a) => a.startsWith("--surface=")) ?? "--surface=all").split("=")[1];

// A fake project, injected via route mocking -- not real DB data, so this
// check doesn't depend on what a real project happens to have saved right
// now (and doesn't touch the real database at all; every route below is
// GET-only and intercepted before it reaches the network).
const PROJECT = {
  id: "e2e-overlap-check-project",
  name: "E2E Overlap Check",
  repo_path: "/tmp/e2e-overlap-check",
  default_branch: "main",
};

const LONG_TEXT = Array.from(
  { length: 6 },
  (_, i) =>
    `${i + 1}번째 줄: 실제 사고 사례(ohso 프로젝트 프롬프트)와 비슷한 길이로 일부러 길게 채운 여러 줄짜리 내용입니다. 로그인 정보나 여러 단계 지침처럼 실사용 데이터는 예시보다 훨씬 길 수 있습니다.`
).join("\n");

const PROMPTS = [
  { id: "p1", project_id: PROJECT.id, title: "짧은 프롬프트", content: "짧은 내용." },
  { id: "p2", project_id: PROJECT.id, title: "아주 긴 프롬프트 (회귀 재현용)", content: LONG_TEXT },
  { id: "p3", project_id: PROJECT.id, title: "중간 길이", content: "첫 줄\n둘째 줄\n셋째 줄" },
];

const PIPELINES = [
  { id: "pl1", project_id: PROJECT.id, name: "짧은 파이프라인", prompt_ids: ["p1"] },
  { id: "pl2", project_id: PROJECT.id, name: "긴 파이프라인 (여러 단계)", prompt_ids: ["p1", "p2", "p3", "p1", "p2"] },
];

async function mockJson(page, urlPattern, body) {
  await page.route(urlPattern, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
  );
}

// Every button inside a .list-item/.task-row must resolve to itself (or a
// descendant of itself) at its own on-screen center -- if a neighboring
// row's box has bled over it, elementFromPoint returns that row instead.
//
// A button whose own row sits right at the scroll container's clipped
// edge is legitimately *not* rendered there (the user just hasn't
// scrolled to it yet) -- elementFromPoint falls through to whatever's
// behind the container in that case, which looks identical to real
// overlap unless it's specifically excluded. Only flag it when the
// covering element is actually another row (a sibling .list-item/
// .task-row, or something inside one) -- that's the flex-shrink bug's
// actual signature, not "scrolled out of view".
async function findOverlapFailures(page, containerSelector, scrollContainerSelector) {
  return page.evaluate(
    ({ sel, scrollSel }) => {
      const scrollContainer = document.querySelector(scrollSel);
      const clip = scrollContainer.getBoundingClientRect();
      const rows = Array.from(document.querySelectorAll(`${sel} .list-item, ${sel} .task-row`));
      const failures = [];
      for (const row of rows) {
        for (const btn of Array.from(row.querySelectorAll("button"))) {
          const rect = btn.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) {
            failures.push({ row: row.textContent.trim().slice(0, 40), button: btn.textContent.trim(), reason: "zero-size" });
            continue;
          }
          const cx = rect.x + rect.width / 2;
          const cy = rect.y + rect.height / 2;
          // Not currently scrolled into view -- nothing to check here.
          if (cx < clip.left || cx > clip.right || cy < clip.top || cy > clip.bottom) {
            continue;
          }
          const top = document.elementFromPoint(cx, cy);
          const ok = top === btn || (top && btn.contains(top));
          if (ok) continue;
          const coveredByRow = top && top.closest(".list-item, .task-row");
          if (!coveredByRow || coveredByRow === row) {
            // Covered by something other than a sibling row (e.g. a modal
            // backdrop peeking through at a clip boundary) -- not the bug
            // this check is for.
            continue;
          }
          failures.push({
            row: row.textContent.trim().slice(0, 40),
            button: btn.textContent.trim(),
            reason: "covered-by-sibling-row",
            coveredBy: coveredByRow.textContent.trim().slice(0, 40),
          });
        }
      }
      return failures;
    },
    { sel: containerSelector, scrollSel: scrollContainerSelector }
  );
}

function report(label, failures) {
  if (failures.length === 0) {
    console.log(`  PASS -- ${label}: no covered buttons`);
    return;
  }
  console.log(`  FAIL -- ${label}: ${failures.length} button(s) covered by another row`);
  for (const f of failures) {
    console.log(`    row "${f.row}" -> button "${f.button}" (${f.reason}${f.coveredBy ? `, covered by ${f.coveredBy}` : ""})`);
  }
}

async function openModal(page) {
  await page.goto(WEB_URL, { waitUntil: "networkidle", timeout: 20000 });
  await page.waitForTimeout(500);
  await page.locator('button:has-text("프로젝트")').first().click();
  await page.waitForTimeout(300);
  const row = page.locator(".list-item", { hasText: PROJECT.name }).first();
  await row.waitFor({ state: "visible", timeout: 10000 });
  await row.locator('button:has-text("Prompts")').click();
  await page.waitForTimeout(600);
}

async function checkPrompts(page) {
  console.log("--- Prompts modal (long multi-line content) ---");
  await mockJson(page, `**/projects/${PROJECT.id}/prompts`, PROMPTS);
  await mockJson(page, `**/projects/${PROJECT.id}/pipelines`, []);
  await openModal(page);
  const failures = await findOverlapFailures(page, ".modal-card", ".modal-card .panel-scroll");
  report("Prompts modal", failures);
  return failures;
}

async function checkPipelines(page) {
  console.log("--- Pipelines modal (several multi-step pipelines) ---");
  await mockJson(page, `**/projects/${PROJECT.id}/prompts`, PROMPTS);
  await mockJson(page, `**/projects/${PROJECT.id}/pipelines`, PIPELINES);
  await openModal(page);
  await page.locator('.modal-card button:has-text("파이프라인")').first().click();
  await page.waitForTimeout(400);
  const failures = await findOverlapFailures(page, ".modal-card", ".modal-card .panel-scroll");
  report("Pipelines modal", failures);
  return failures;
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  // Both checks reuse the same fake project id/name, injected fresh per
  // page load -- no shared route mock leaks across checks in this run.
  await mockJson(page, "**/projects", [PROJECT]);

  let allFailures = [];
  if (surface === "all" || surface === "prompts") {
    allFailures = allFailures.concat(await checkPrompts(page));
  }
  if (surface === "all" || surface === "pipelines") {
    allFailures = allFailures.concat(await checkPipelines(page));
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
