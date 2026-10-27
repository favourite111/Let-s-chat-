/**
 * Shared plumbing for the browser suites.
 *
 * These tests drive the real production build in real Chromium with a fake
 * camera, because the things worth protecting here (mesh negotiation, roster
 * accuracy, host authorization) are exactly the things a mocked test would
 * pretend to verify.
 *
 * They live in the repo rather than in a scratch directory so a regression in
 * call setup is caught by whoever runs `pnpm run e2e` next, not rediscovered by
 * a user.
 */
import { chromium, devices } from "playwright";

export const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:4600";

export const CHROME_ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  "--no-sandbox",
];

export const PHONE = {
  ...devices["iPhone 13"],
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Collect pass/fail lines and exit non-zero if anything failed. */
export function createReporter(title) {
  const results = [];

  const check = (ok, name, detail = "") => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  };

  const finish = () => {
    const failed = results.filter((r) => !r).length;
    console.log(`\n${title}: ${results.length - failed}/${results.length} checks passed`);
    return failed;
  };

  return { check, finish };
}

export async function launch() {
  return chromium.launch({ args: CHROME_ARGS });
}

/** One "device": its own browser context, storage and camera. */
export async function makeDevice(browser, name, options = {}) {
  const context = await browser.newContext({
    permissions: ["camera", "microphone"],
    ...options,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(`${name}: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !/favicon|ERR_ABORTED|net::ERR_/.test(msg.text())) {
      errors.push(`${name}: ${msg.text()}`);
    }
  });
  return { name, context, page, errors };
}

export async function waitFor(fn, label, timeout = 40000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {
      /* page mid-navigation */
    }
    await sleep(400);
  }
  throw new Error(`timed out: ${label}`);
}

/** Create a room from the home page and return its URL. */
export async function createRoom(device) {
  await device.page.goto(BASE, { waitUntil: "domcontentloaded" });
  await device.page.getByRole("button", { name: /create room/i }).click();
  await device.page.waitForURL(/\/room\/[0-9a-z]+/, { timeout: 20000 });
  return device.page.url();
}

/** Walk the pre-join screen and enter the call. */
export async function joinAs(device, url, name) {
  await device.page.goto(url, { waitUntil: "domcontentloaded" });
  await device.page.waitForSelector('input[aria-label="Your name"]', { timeout: 20000 });
  await device.page.fill('input[aria-label="Your name"]', name);
  await device.page.getByRole("button", { name: /join call/i }).click();
}

/** Everything the UI says about the call, read from the DOM. */
export const view = (page) =>
  page.evaluate(() => {
    const text = document.body.innerText;
    const pill = [...document.querySelectorAll("[aria-label]")]
      .map((el) => el.getAttribute("aria-label"))
      .find((label) => /^\d+ participants?$/.test(label ?? ""));

    const remoteTiles = [...document.querySelectorAll('[data-testid="tile-remote"]')].map((el) => {
      const video = el.querySelector("video");
      return {
        id: el.getAttribute("data-participant-id"),
        name: el.getAttribute("data-name"),
        width: video?.videoWidth ?? 0,
        playing: video ? !video.paused : false,
        muted: el.getAttribute("data-muted") === "true",
        videoOff: el.getAttribute("data-video-off") === "true",
        hasStream: el.getAttribute("data-has-stream") === "true",
      };
    });

    return {
      count: pill ? Number(pill.split(" ")[0]) : null,
      remoteTiles,
      tiles: document.querySelectorAll('[data-testid^="tile-"]').length,
      isHost: text.includes("Host"),
      waiting: text.includes("Waiting for others to join"),
      closed: text.includes("Call ended"),
      removed: text.includes("You were removed"),
      full: text.includes("Room is full"),
      prejoin: Boolean(document.querySelector('input[aria-label="Your name"]')),
    };
  });

export const barLabels = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".call-controls-bar button")].map(
      (b) => b.getAttribute("aria-label") ?? b.innerText.trim(),
    ),
  );

export const roomInfo = (roomId) =>
  fetch(`${BASE}/api/rooms/${roomId}`).then((res) => res.json());
