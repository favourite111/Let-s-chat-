/**
 * The 1:1 path, after the mesh rewrite.
 *
 * Group calling must not have broken the thing that already worked: two people,
 * one connection, host sheet, removal, reload and reconnect.
 */
import {
  PHONE,
  barLabels,
  createReporter,
  createRoom,
  joinAs,
  launch,
  makeDevice,
  roomInfo,
  sleep,
  view,
  waitFor,
} from "./helpers.mjs";

const { check, finish } = createReporter("1:1 call");

const browser = await launch();
const host = await makeDevice(browser, "host", PHONE);
const roomUrl = await createRoom(host);
const roomId = roomUrl.split("/room/")[1];

await host.page.fill('input[aria-label="Your name"]', "Ada");
await host.page.getByRole("button", { name: /join call/i }).click();
await waitFor(async () => (await view(host.page)).count === 1, "host in the call", 20000);

const guest = await makeDevice(browser, "guest");
await joinAs(guest, roomUrl, "Grace");
await waitFor(async () => (await view(host.page)).count === 2, "guest joins", 25000);

// ── Real media both ways ───────────────────────────────────────────────────
await waitFor(async () => {
  const [h, g] = [await view(host.page), await view(guest.page)];
  return h.remoteTiles.some((t) => t.width > 0) && g.remoteTiles.some((t) => t.width > 0);
}, "video both ways", 30000);
check(true, "1:1 video flows both ways");
check((await view(guest.page)).isHost === false, "the second person is not the host");

// ── Control bar stays three buttons ────────────────────────────────────────
check((await barLabels(host.page)).length === 3, "host bar is three controls",
  (await barLabels(host.page)).join(", "));
check((await barLabels(guest.page)).length === 3, "guest bar is three controls",
  (await barLabels(guest.page)).join(", "));
check((await guest.page.getByTestId("host-menu-button").count()) === 0, "guests have no host menu");

// ── Guest Leave is unchanged ───────────────────────────────────────────────
await guest.page.getByRole("button", { name: /leave call/i }).click();
await sleep(1000);
check((await view(guest.page)).prejoin === false && !guest.page.url().includes("/room/"),
  "guest Leave leaves at once, no sheet");
check((await roomInfo(roomId)).closed === false, "the room stays open after a guest leaves");

// ── Reload reclaims the seat instead of duplicating ────────────────────────
const guest2 = await makeDevice(browser, "guest2");
await joinAs(guest2, roomUrl, "Grace");
await waitFor(async () => (await view(host.page)).count === 2, "second guest", 25000);

await guest2.page.reload({ waitUntil: "domcontentloaded" });
await guest2.page.waitForSelector('input[aria-label="Your name"]', { timeout: 20000 });
await guest2.page.getByRole("button", { name: /join call/i }).click();

await waitFor(async () => {
  const [h, g] = [await view(host.page), await view(guest2.page)];
  return h.count === 2 && g.count === 2 && h.remoteTiles.every((t) => t.width > 0);
}, "count restored after reload", 40000);
check(true, "a reload keeps the count at 2 and the video returns");

// ── Host Leave keeps the room alive ────────────────────────────────────────
await host.page.getByRole("button", { name: /leave call/i }).click();
await host.page.waitForSelector('[role="dialog"]', { timeout: 8000 });
check(/Leave this call\?/i.test(await host.page.locator('[role="dialog"]').innerText()),
  "host Leave asks first");
await host.page.getByTestId("sheet-action-leave-call").click();
await sleep(1200);
const afterHostLeave = await roomInfo(roomId);
check(afterHostLeave.closed === false && afterHostLeave.participantCount === 1,
  "Leave call keeps the room open for the guest", JSON.stringify(afterHostLeave));

// ── End for everyone, from a window of the same browser ────────────────────
// Ownership lives in the profile's localStorage, so this is the "closed the
// window and reopened the link" case — a different browser would be a guest.
const hostPage2 = await host.context.newPage();
await hostPage2.goto(roomUrl, { waitUntil: "domcontentloaded" });
await hostPage2.waitForSelector('input[aria-label="Your name"]', { timeout: 20000 });
await hostPage2.fill('input[aria-label="Your name"]', "Ada");
await hostPage2.getByRole("button", { name: /join call/i }).click();
await waitFor(async () => (await view(hostPage2)).count === 2, "host back", 25000);
check((await view(hostPage2)).isHost === true, "reopening in the same browser keeps ownership");

const host2 = { page: hostPage2 };

await host2.page.getByRole("button", { name: /leave call/i }).click();
await host2.page.getByTestId("sheet-action-end-for-everyone").click();
await waitFor(async () => (await view(guest2.page)).closed, "guest told the call ended", 25000);
check((await roomInfo(roomId)).closed === true, "the room is closed for good");

// A reloaded guest cannot get back in: the closed room is refused before the
// camera is even switched on.
await guest2.page.reload({ waitUntil: "domcontentloaded" });
await waitFor(async () => (await view(guest2.page)).closed, "closed room refuses rejoin", 20000);
const closedView = await view(guest2.page);
check(closedView.closed && !closedView.prejoin, "a closed room refuses rejoin after a reload");

await browser.close();
process.exit(finish() === 0 ? 0 : 1);
