/**
 * Group calling: four people in one room, as a peer mesh.
 *
 * A mesh means every pair connects independently, so this checks each person's
 * own tiles and frames rather than "somebody is connected somewhere".
 */
import {
  BASE,
  PHONE,
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

const { check, finish } = createReporter("group call");

const browser = await launch();
const host = await makeDevice(browser, "host", PHONE);
const roomUrl = await createRoom(host);
const roomId = roomUrl.split("/room/")[1];

// ── Pre-join ───────────────────────────────────────────────────────────────
await host.page.waitForSelector('input[aria-label="Your name"]', { timeout: 20000 });
check((await view(host.page)).prejoin, "a link opens the pre-join screen, not the call");

await waitFor(
  () => host.page.evaluate(() => {
    const video = document.querySelector("video");
    return Boolean(video && video.videoWidth > 0);
  }),
  "preview frames",
  15000,
);
check(true, "the pre-join screen shows your own camera");

await host.page.fill('input[aria-label="Your name"]', "Ada");
await host.page.getByRole("button", { name: /join call/i }).click();
await waitFor(async () => (await view(host.page)).count === 1, "host in the call", 20000);
check(true, "the host enters the call after joining");

// ── Fill the room ──────────────────────────────────────────────────────────
const grace = await makeDevice(browser, "grace");
const kofi = await makeDevice(browser, "kofi", PHONE);
const wale = await makeDevice(browser, "wale");

await joinAs(grace, roomUrl, "Grace");
await waitFor(async () => (await view(host.page)).count === 2, "grace joins", 25000);
await joinAs(kofi, roomUrl, "Kofi");
await joinAs(wale, roomUrl, "Wale");

const people = [host, grace, kofi, wale];

const everyoneSeesEveryone = async (group) => {
  for (const person of group) {
    const state = await view(person.page);
    if (state.count !== group.length) return false;
    if (state.remoteTiles.length !== group.length - 1) return false;
    if (!state.remoteTiles.every((tile) => tile.width > 0)) return false;
  }
  return true;
};

await waitFor(() => everyoneSeesEveryone(people), "a full four-way mesh", 60000);
check(true, "all four people see each other with video");

const hostView = await view(host.page);
check(hostView.count === 4, "the participant count says 4", String(hostView.count));
check(hostView.remoteTiles.length === 3, "the host has three remote tiles");
check(
  hostView.remoteTiles.every((tile) => tile.playing && tile.width > 0),
  "every remote tile is playing real frames",
  JSON.stringify(hostView.remoteTiles.map((tile) => tile.width)),
);
check(
  ["Grace", "Kofi", "Wale"].every((name) =>
    hostView.remoteTiles.some((tile) => tile.name === name),
  ),
  "remote tiles are labelled with names",
  hostView.remoteTiles.map((tile) => tile.name).join(", "),
);

// ── Exactly one host ───────────────────────────────────────────────────────
const hostFlags = [];
for (const person of people) hostFlags.push((await view(person.page)).isHost);
check(hostFlags.filter(Boolean).length === 1, "exactly one person is the host", JSON.stringify(hostFlags));

// ── Capacity ───────────────────────────────────────────────────────────────
const fifth = await makeDevice(browser, "fifth");
await joinAs(fifth, roomUrl, "Fifth");
await waitFor(async () => (await view(fifth.page)).full, "fifth told the room is full", 20000);
check((await view(fifth.page)).full, "a fifth person is told the room is full");
check(!(await view(fifth.page)).closed, "and it is not a terminal failure");

// ── Mute propagates ────────────────────────────────────────────────────────
await kofi.page.getByRole("button", { name: /mute microphone/i }).click();
await waitFor(async () => (await view(host.page)).remoteTiles.some((tile) => tile.muted), "mute", 15000);
const mutedTiles = (await view(host.page)).remoteTiles.filter((tile) => tile.muted);
check(mutedTiles.length === 1 && mutedTiles[0].name === "Kofi", "the muted peer is the one flagged",
  JSON.stringify(mutedTiles.map((tile) => tile.name)));

await kofi.page.getByRole("button", { name: /unmute microphone/i }).click();
await waitFor(async () => (await view(host.page)).remoteTiles.every((tile) => !tile.muted), "unmute", 15000);
check(true, "unmuting clears the flag for the room");

// ── One person leaves ──────────────────────────────────────────────────────
const beforeLeave = await view(host.page);
await wale.page.getByRole("button", { name: /leave call/i }).click();
await sleep(800);
await wale.context.close();

await waitFor(async () => (await view(host.page)).count === 3, "count drops to 3", 25000);
const afterLeave = await view(host.page);
check(beforeLeave.remoteTiles.length === 3, "before leaving there were three remote tiles");
check(afterLeave.count === 3, "the remaining three are counted", String(afterLeave.count));
check(afterLeave.remoteTiles.length === 2, "the departed tile is gone", String(afterLeave.remoteTiles.length));

const remaining = [host, grace, kofi];
await waitFor(() => everyoneSeesEveryone(remaining), "mesh after a departure", 40000);
check(true, "the surviving three still see each other");

// ── Remove one specific person ─────────────────────────────────────────────
await host.page.getByTestId("host-menu-button").click();
const removeActions = await host.page.locator('[data-testid^="sheet-action-remove-"]').count();
check(removeActions === 2, "the host menu lists one Remove per other person", String(removeActions));
const removeLabels = await host.page.locator('[data-testid^="sheet-action-remove-"]').allInnerTexts();
check(
  removeLabels.some((text) => /Grace/.test(text)) && removeLabels.some((text) => /Kofi/.test(text)),
  "each Remove names the person",
  removeLabels.map((text) => text.split("\n")[0]).join(" | "),
);

await host.page.locator('[data-testid^="sheet-action-remove-"]').nth(1).click();
await host.page.getByTestId("sheet-action-confirm-remove").click();
await waitFor(async () => (await view(kofi.page)).removed, "kofi removed", 25000);
check(true, "removing one person from a group disconnects only them");
check((await view(grace.page)).count === 2, "the rest of the room is unaffected",
  String((await view(grace.page)).count));

// ── Host ends the group call ───────────────────────────────────────────────
await host.page.getByRole("button", { name: /leave call/i }).click();
await host.page.getByTestId("sheet-action-end-for-everyone").click();
await waitFor(async () => (await view(grace.page)).closed, "grace told the call ended", 25000);
const closed = await roomInfo(roomId);
check(closed.closed === true, "the group call is closed server-side", JSON.stringify(closed));

// ── No page errors ─────────────────────────────────────────────────────────
const allErrors = people.flatMap((p) => p.errors).filter((e) => !/NotFoundError|NotAllowed/.test(e));
check(allErrors.length === 0, "no uncaught page errors", allErrors.slice(0, 3).join(" | "));

await browser.close();
process.exit(finish() === 0 ? 0 : 1);
