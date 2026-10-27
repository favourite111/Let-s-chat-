/**
 * Layout check for the group grid and the control bar, at real device widths.
 *
 * The tile grid is the part most likely to be wrong on a phone: four videos,
 * a header and a control bar have to share ~390×844 without overlapping or
 * pushing anything off-screen.
 */
import {
  PHONE,
  barLabels,
  createReporter,
  createRoom,
  joinAs,
  launch,
  makeDevice,
  sleep,
  view,
  waitFor,
} from "./helpers.mjs";

const { check, finish } = createReporter("group layout");

const SIZES = [
  { name: "iphone-se-320", width: 320, height: 568 },
  { name: "iphone-13-390", width: 390, height: 844 },
  { name: "pixel-7-412", width: 412, height: 915 },
];

const browser = await launch();

/** Geometry of the grid and the bar. */
const geometry = (page) =>
  page.evaluate(() => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
        right: Math.round(r.right),
        bottom: Math.round(r.bottom),
      };
    };

    const tiles = [...document.querySelectorAll('[data-testid^="tile-"]')].map(rect);
    const bar = document.querySelector(".call-controls-bar");
    const buttons = [...bar.querySelectorAll("button")].map((b) => ({
      label: b.getAttribute("aria-label"),
      ...rect(b),
    }));

    return {
      tiles,
      bar: rect(bar),
      buttons,
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  });

for (const size of SIZES) {
  const host = await makeDevice(browser, `host-${size.name}`, {
    ...PHONE,
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 2,
  });

  const roomUrl = await createRoom(host);
  await host.page.fill('input[aria-label="Your name"]', "Ada");
  await host.page.getByRole("button", { name: /join call/i }).click();
  await waitFor(async () => (await view(host.page)).count === 1, "joined", 20000);

  // Two more people, so the grid is the 2×2 case.
  const a = await makeDevice(browser, `a-${size.name}`);
  const b = await makeDevice(browser, `b-${size.name}`);
  await joinAs(a, roomUrl, "Grace");
  await waitFor(async () => (await view(host.page)).count === 2, "second person", 25000);
  await joinAs(b, roomUrl, "Kofi");
  await waitFor(async () => (await view(host.page)).count === 3, "third person", 25000);
  await sleep(1200);

  const g = await geometry(host.page);
  const name = size.name;

  check(g.tiles.length === 3, `[${name}] three tiles rendered`, String(g.tiles.length));
  check(
    g.tiles.every((t) => t.x >= 0 && t.right <= g.vw && t.w > 40 && t.h > 40),
    `[${name}] every tile is on-screen and usable`,
    g.tiles.map((t) => `${t.w}×${t.h}`).join(" "),
  );

  // No tile may overlap another.
  let overlap = false;
  for (let i = 0; i < g.tiles.length; i += 1) {
    for (let j = i + 1; j < g.tiles.length; j += 1) {
      const A = g.tiles[i];
      const B = g.tiles[j];
      if (A.x < B.right && B.x < A.right && A.y < B.bottom && B.y < A.bottom) overlap = true;
    }
  }
  check(!overlap, `[${name}] tiles do not overlap`);

  // Nothing may sit under the control bar.
  check(
    g.tiles.every((t) => t.bottom <= g.bar.y + 2),
    `[${name}] no tile runs under the control bar`,
    `lowest tile ${Math.max(...g.tiles.map((t) => t.bottom))} vs bar ${g.bar.y}`,
  );

  const bar = await barLabels(host.page);
  check(bar.length === 3, `[${name}] the bar is still three controls`, bar.join(", "));
  check(
    g.buttons.every((btn) => btn.x >= 0 && btn.right <= g.vw && btn.h >= 44),
    `[${name}] every control is on-screen and tappable`,
    g.buttons.map((btn) => `${btn.label}:${btn.w}×${btn.h}`).join(" "),
  );

  await host.page.screenshot({ path: `/tmp/shots/grid-${size.name}.png` });

  await host.context.close();
  await a.context.close();
  await b.context.close();
}

await browser.close();
process.exit(finish() === 0 ? 0 : 1);
