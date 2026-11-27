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
const attachmentsOnly = process.argv.includes("--attachments-only");
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
  if (!attachmentsOnly) {
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
  if (!attachmentsOnly) {
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

  for (const viewport of [{ width: 1400, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const imageData = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1600;
      canvas.height = 1000;
      const drawing = canvas.getContext("2d");
      drawing.fillStyle = "#0f3158";
      drawing.fillRect(0, 0, canvas.width, canvas.height);
      drawing.fillStyle = "#ffffff";
      drawing.font = "64px sans-serif";
      drawing.fillText("Image preview · 1600 × 1000", 80, 160);
      drawing.fillStyle = "#83b5e5";
      drawing.fillRect(80, 240, 1440, 680);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    const imageBytes = Buffer.from(imageData, "base64");
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const conversation = {
      id: "e2e-attachments", title: "첨부파일 확인", project_id: "e2e-project", project_name: "테스트 프로젝트",
      task_id: null, task_status: null, messages: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    const uploaded = [];
    await page.route("**/*", async (route) => {
      const request = route.request();
      const requestPath = new URL(request.url()).pathname.replace(/^\/api/, "");
      if (!/^\/(conversations|projects|runtime|prompts|tasks)(\/|$)/.test(requestPath)) return route.continue();
      let body = [];
      if (requestPath === "/conversations") body = [conversation];
      else if (requestPath === "/conversations/counts") body = { "e2e-project": 1 };
      else if (requestPath === "/conversations/e2e-attachments") body = conversation;
      else if (requestPath === "/projects") body = [{ id: "e2e-project", name: "테스트 프로젝트" }];
      else if (requestPath === "/runtime/engines") body = { default_engine: "codex", engines: [{ id: "codex", label: "Codex" }] };
      else if (requestPath === "/runtime/models") body = { models: [{ id: "default" }] };
      else if (/^\/conversations\/e2e-attachments\/attachments\/file-/.test(requestPath)) {
        return route.fulfill({
          status: 200, contentType: "application/octet-stream",
          body: imageBytes,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
      else if (requestPath === "/conversations/e2e-attachments/attachments") {
        body = {
          id: `file-${uploaded.length}`, name: new URL(request.url()).searchParams.get("name"),
          size: request.postDataBuffer().length,
        };
        uploaded.push(body);
      } else if (requestPath === "/conversations/e2e-attachments/messages") {
        const payload = request.postDataJSON();
        conversation.messages.push({
          id: "message-1", conversation_id: conversation.id, role: "user", content: payload.content,
          attachments: uploaded.filter((item) => payload.attachment_ids.includes(item.id)), created_at: new Date().toISOString(),
        });
        body = conversation;
      }
      await route.fulfill({
        status: 200, contentType: "application/json", body: JSON.stringify(body),
        headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" },
      });
    });
    await page.addInitScript(() => {
      localStorage.setItem("zenbar:lastView", JSON.stringify({
        desktopView: "chat", mobileScreen: "conversation-detail", selectedConversationId: "e2e-attachments",
      }));
    });
    await page.goto(WEB_URL, { waitUntil: "networkidle", timeout: 20000 });
    const filename = `${"길고_복잡한_요구사항_파일명_".repeat(5)}.txt`;
    await page.getByLabel("첨부파일 선택").setInputFiles([
      { name: filename, mimeType: "text/plain", buffer: Buffer.from("requirements") },
      { name: "notes.json", mimeType: "application/json", buffer: Buffer.from("{}") },
    ]);
    await page.getByRole("button", { name: "notes.json 첨부 취소" }).waitFor();
    console.log(`--- Attachments: ${viewport.width}px ---`);
    allFailures = allFailures.concat(reportGeometryDrift(await collectIconButtons(page)));
    const layoutFailures = await page.locator(".compose-file-list").evaluate((list) => {
      const failures = [];
      for (const button of list.querySelectorAll("button")) {
        const rect = button.getBoundingClientRect();
        const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        if (!target || !button.contains(target)) failures.push("attachment remove button is clipped or covered");
      }
      if (document.documentElement.scrollWidth > window.innerWidth) failures.push("horizontal overflow");
      return failures;
    });
    allFailures = allFailures.concat(layoutFailures, errors);
    await page.screenshot({ path: path.join(OUT_DIR, `attachments-${viewport.width}.png`) });
    await page.getByRole("button", { name: "notes.json 첨부 취소" }).click();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("link", { name: filename, exact: false }).waitFor();
    if (uploaded.length !== 1) allFailures.push("removed attachment was uploaded");
    await page.getByLabel("첨부파일 선택").setInputFiles({ name: "미리보기.PNG", mimeType: "image/png", buffer: imageBytes });
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const imageTrigger = page.getByRole("button", { name: /미리보기.PNG/ });
    await imageTrigger.click();
    const viewer = page.getByRole("dialog", { name: "미리보기.PNG 이미지 미리보기" });
    await viewer.waitFor();
    await viewer.getByRole("img").evaluate((image) => image.decode());
    const viewerFailures = await viewer.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < 0 || rect.right > innerWidth || rect.top < 0 || rect.bottom > innerHeight
        ? ["image viewer overflows viewport"] : [];
    });
    allFailures = allFailures.concat(viewerFailures);
    await page.screenshot({ path: path.join(OUT_DIR, `attachment-viewer-${viewport.width}.png`) });
    await page.keyboard.press("Escape");
    if (await viewer.count()) allFailures.push("Escape did not close image viewer");
    if (!(await imageTrigger.evaluate((element) => document.activeElement === element))) allFailures.push("image viewer did not restore focus");
    await imageTrigger.click();
    await page.getByRole("button", { name: "이미지 미리보기 닫기" }).click();
    allFailures = allFailures.concat(errors);
    console.log(`  ${layoutFailures.length + errors.length ? "FAIL" : "PASS"} -- attachment layout and upload`);
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
