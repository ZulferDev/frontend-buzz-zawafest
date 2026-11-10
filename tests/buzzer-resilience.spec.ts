import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const frontendUrl = process.env.ZAWA_E2E_FRONTEND_URL ?? "http://127.0.0.1:5174";
const backendUrl = process.env.ZAWA_E2E_BACKEND_URL ?? "http://127.0.0.1:3310";

const teams = [
  { id: "e2e-delayed", name: "Tim E2E Tertunda", score: 0, soundData: "" },
  { id: "e2e-immediate", name: "Tim E2E Langsung", score: 0, soundData: "" },
  { id: "e2e-spam", name: "Tim E2E Spam", score: 0, soundData: "" },
];

async function openRound() {
  const current = await (await fetch(`${backendUrl}/api/state`)).json();
  const response = await fetch(`${backendUrl}/api/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      state: {
        version: 1,
        teams,
        questions: [],
        currentQuestionId: null,
        rebuttalOpen: true,
        buzzerTeamId: null,
        screen: "question",
        updatedAt: Date.now(),
      },
      expectedRevision: current.revision,
    }),
  });
  expect(response.ok).toBeTruthy();
  return response.json();
}

async function openPlayer(browserContext: BrowserContext, teamId: string): Promise<Page> {
  const page = await browserContext.newPage();
  await page.goto(`${frontendUrl}/player?team_id=${teamId}`);
  await expect(page.getByRole("button", { name: /BUZZ/ })).toBeVisible();
  return page;
}

test.beforeEach(() => {
  const backendHost = new URL(backendUrl).hostname;
  expect(["127.0.0.1", "localhost"]).toContain(backendHost);
});

test("allows only one accepted claim when an earlier click is delayed in transit", async ({ browser }) => {
  const round = await openRound();
  const delayedContext = await browser.newContext();
  const immediateContext = await browser.newContext();
  const results: boolean[] = [];
  let markDelayedRequestStarted!: () => void;
  const delayedRequestStarted = new Promise<void>((resolve) => {
    markDelayedRequestStarted = resolve;
  });

  try {
    const delayedPage = await openPlayer(delayedContext, "e2e-delayed");
    const immediatePage = await openPlayer(immediateContext, "e2e-immediate");

    await delayedPage.route("**/api/buzzer", async (route) => {
      if (route.request().postDataJSON().teamId === "e2e-delayed") {
        markDelayedRequestStarted();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await route.continue();
    });
    for (const page of [delayedPage, immediatePage]) {
      page.on("response", async (response) => {
        if (response.url() === `${backendUrl}/api/buzzer`) {
          results.push((await response.json()).accepted);
        }
      });
    }

    await delayedPage.getByRole("button", { name: /BUZZ/ }).click();
    await delayedRequestStarted;
    await immediatePage.getByRole("button", { name: /BUZZ/ }).click();

    await expect(immediatePage.getByText("Kamu yang tercepat!")).toBeVisible();
    await expect(delayedPage.getByText("Tim lain lebih dulu")).toBeVisible();
    await expect.poll(() => results.length).toBe(2);

    const finalSnapshot = await (await fetch(`${backendUrl}/api/state`)).json();
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(finalSnapshot.revision).toBe(round.revision + 1);
    expect(finalSnapshot.state.buzzerTeamId).toBe("e2e-immediate");
  } finally {
    await Promise.all([delayedContext.close(), immediateContext.close()]);
  }
});

test("keeps the first accepted team when another team sends a bounded duplicate-click burst", async ({ browser }) => {
  const round = await openRound();
  const spamContext = await browser.newContext();
  const competitorContext = await browser.newContext();
  const page = await openPlayer(spamContext, "e2e-spam");
  const competitorPage = await openPlayer(competitorContext, "e2e-immediate");
  const results: boolean[] = [];
  let requestCount = 0;
  let releaseRequests!: () => void;
  const requestGate = new Promise<void>((resolve) => {
    releaseRequests = resolve;
  });

  try {
    await page.route("**/api/buzzer", async (route) => {
      requestCount += 1;
      await requestGate;
      await route.continue();
    });
    for (const target of [page, competitorPage]) {
      target.on("response", async (response) => {
        if (response.url() === `${backendUrl}/api/buzzer`) {
          results.push((await response.json()).accepted);
        }
      });
    }

    await page.getByRole("button", { name: /BUZZ/ }).evaluate((button: HTMLButtonElement) => {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        button.click();
      }
    });
    await expect.poll(() => requestCount).toBe(12);
    await competitorPage.getByRole("button", { name: /BUZZ/ }).click();
    await expect(competitorPage.getByText("Kamu yang tercepat!")).toBeVisible();
    releaseRequests();
    await expect.poll(() => results.length).toBe(13);
    await expect(page.getByText("Tim lain lebih dulu")).toBeVisible();

    const finalSnapshot = await (await fetch(`${backendUrl}/api/state`)).json();
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(finalSnapshot.revision).toBe(round.revision + 1);
    expect(finalSnapshot.state.buzzerTeamId).toBe("e2e-immediate");
  } finally {
    releaseRequests();
    await Promise.all([spamContext.close(), competitorContext.close()]);
  }
});
