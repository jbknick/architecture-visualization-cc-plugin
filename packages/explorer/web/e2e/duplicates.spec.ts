import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const shots = resolve(here, "../../../../docs/milestones/screenshots");

// The duplicates view on the mock API: `scenario=dups` is a synthetic 22-group result over 7 workspaces, shaped like
// a real monorepo's (mostly nearly identical copies, no vector tiers). Nothing here comes from a private project.
// The mock keeps dismissals in memory for the whole run, so the dismissal test goes last and the file runs in order.
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });

const url = "/#/duplicates?scenario=dups";
const list = (page: Page) => page.getByRole("list", { name: "Duplicate groups, biggest first" });

async function open(page: Page) {
  mkdirSync(shots, { recursive: true });
  await page.goto(url);
  await expect(list(page).getByRole("button").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("region", { name: /Compare/ }).getByText(/differing line/)).toBeVisible();
  await page.mouse.move(2, 2);
}

/** Every visible box inside the canvas stays inside it, and the list rows do not overlap each other. */
async function expectNoOverlap(page: Page) {
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    const canvas = document.querySelector('[data-testid="duplicates-canvas"]') as HTMLElement;
    const c = canvas.getBoundingClientRect();
    const rows = [...document.querySelectorAll(".dup-row")] as HTMLElement[];
    let prev: DOMRect | null = null;
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (r.height === 0) continue;
      if (prev && r.top < prev.bottom - 0.5 && r.bottom > prev.top + 0.5)
        out.push(`rows overlap at ${row.textContent}`);
      if (r.right > c.right + 1 || r.left < c.left - 1) out.push(`row leaves the canvas: ${row.textContent}`);
      if (row.scrollWidth > row.clientWidth + 1) out.push(`row text overflows: ${row.textContent}`);
      prev = r;
    }
    for (const el of document.querySelectorAll(".dup-card, .dup-detail, .dup-diff, .dup-overview")) {
      const r = el.getBoundingClientRect();
      if (r.right > c.right + 1) out.push(`${el.className} leaves the canvas`);
    }
    // Cards sit side by side or stacked, never on top of each other.
    const cards = [...document.querySelectorAll(".dup-card")].map((e) => e.getBoundingClientRect());
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        const a = cards[i] as DOMRect;
        const b = cards[j] as DOMRect;
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) {
          out.push("cards overlap");
        }
      }
    }
    return out;
  });
  expect(problems).toEqual([]);
}

test("22 groups: ranked list on the left, the selected group and its side-by-side on the right", async ({
  page,
}) => {
  await open(page);
  await expect(page.getByText(/^22 groups · \d+ functions · about [\d,]+ duplicated lines$/)).toBeVisible();
  await expect(list(page).getByRole("button")).toHaveCount(22);
  // Ranked: the first row is the biggest (most copies of the longest code).
  await expect(list(page).getByRole("button").first()).toContainText("formatDuration");
  await expect(page.getByRole("note")).toContainText("Run gantry embed");
  await expectNoOverlap(page);
  await page.screenshot({ path: resolve(shots, "duplicates-large.png") });

  // Pick another group; the detail follows.
  await list(page).getByRole("button").nth(4).click();
  await expect(page.getByTestId("dup-detail").getByRole("heading", { level: 2 })).not.toContainText(
    "formatDuration",
  );
  await expectNoOverlap(page);
});

test("22 groups, dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page);
  await expectNoOverlap(page);
  await page.screenshot({ path: resolve(shots, "duplicates-large-dark.png") });
});

test("keyboard: arrow keys move through the list and the detail follows", async ({ page }) => {
  await open(page);
  const first = list(page).getByRole("button").first();
  await first.focus();
  await page.keyboard.press("ArrowDown");
  await expect(list(page).getByRole("button").nth(1)).toHaveAttribute("aria-current", "true");
});

test("Not a duplicate: hides the pair and the overview count drops", async ({ page }) => {
  await open(page);
  const overview = page.locator(".dup-overview-line");
  const before = (await overview.textContent()) ?? "";
  await page.getByRole("button", { name: "Not a duplicate" }).first().click();
  await page.getByRole("button", { name: "Hide this pair" }).click();
  await expect(page.getByText(/is no longer listed as a duplicate/)).toBeVisible();
  await expect(overview).not.toHaveText(before);
  await expect(page.getByRole("button", { name: /Undo/ })).toHaveCount(0);
});
