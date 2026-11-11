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
  const buzzer = page.getByRole("button", { name: /BUZZ/ });
  await expect(buzzer).toBeVisible();
  await expect(buzzer).toBeEnabled();
  return page;
}

test.beforeEach(() => {
  const backendHost = new URL(backendUrl).hostname;
  expect(["127.0.0.1", "localhost"]).toContain(backendHost);
});

test("the first BUZZ message received by the server wins even when an earlier click is delayed", async ({ browser }) => {
  const round = await openRound();
  const delayedContext = await browser.newContext();
  const immediateContext = await browser.newContext();
  let markDelayedRequestStarted!: () => void;
  const delayedRequestStarted = new Promise<void>((resolve) => {
    markDelayedRequestStarted = resolve;
  });

  try {
    const delayedPage = await delayedContext.newPage();
    await delayedPage.routeWebSocket("**/ws", (route) => {
      const server = route.connectToServer();
      route.onMessage((message) => {
        const payload = JSON.parse(String(message));
        if (payload.type === "BUZZ" && payload.clientId === "e2e-delayed") {
          markDelayedRequestStarted();
          setTimeout(() => server.send(message), 500);
        } else {
          server.send(message);
        }
      });
      server.onMessage((message) => route.send(message));
    });
    await delayedPage.goto(`${frontendUrl}/player?team_id=e2e-delayed`);
    await expect(delayedPage.getByRole("button", { name: /BUZZ/ })).toBeVisible();
    await expect(delayedPage.getByRole("button", { name: /BUZZ/ })).toBeEnabled();
    const immediatePage = await openPlayer(immediateContext, "e2e-immediate");

    await delayedPage.getByRole("button", { name: /BUZZ/ }).click();
    await delayedRequestStarted;
    await immediatePage.getByRole("button", { name: /BUZZ/ }).click();

    await expect(immediatePage.getByText("Kamu yang tercepat!")).toBeVisible();
    await expect(delayedPage.getByText("Tim lain lebih dulu")).toBeVisible();

    const finalSnapshot = await (await fetch(`${backendUrl}/api/state`)).json();
    expect(finalSnapshot.revision).toBe(round.revision + 1);
    expect(finalSnapshot.state.buzzerTeamId).toBe("e2e-immediate");
  } finally {
    await Promise.all([delayedContext.close(), immediateContext.close()]);
  }
});

test("deduplicates a bounded click burst and accepts a later single claim", async ({ browser }) => {
  const round = await openRound();
  const spamContext = await browser.newContext();
  const competitorContext = await browser.newContext();
  const page = await spamContext.newPage();
  const competitorPage = await openPlayer(competitorContext, "e2e-immediate");
  let requestCount = 0;
  let releaseRequests!: () => void;
  const requestGate = new Promise<void>((resolve) => { releaseRequests = resolve; });

  try {
    await page.routeWebSocket("**/ws", (route) => {
      const server = route.connectToServer();
      route.onMessage(async (message) => {
        const payload = JSON.parse(String(message));
        if (payload.type === "BUZZ") {
          requestCount += 1;
          await requestGate;
        }
        server.send(message);
      });
      server.onMessage((message) => route.send(message));
    });
    await page.goto(`${frontendUrl}/player?team_id=e2e-spam`);
    await expect(page.getByRole("button", { name: /BUZZ/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /BUZZ/ })).toBeEnabled();

    await page.getByRole("button", { name: /BUZZ/ }).evaluate((button: HTMLButtonElement) => {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        button.click();
      }
    });

    await expect.poll(() => requestCount).toBe(1);
    await expect(page.getByRole("button", { name: /TERKIRIM/ })).toBeDisabled();
    releaseRequests();
    await expect(page.getByText("Kamu yang tercepat!")).toBeVisible();
    const lateResponse = await fetch(`${backendUrl}/api/buzzer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamId: "e2e-immediate" }),
    });
    const lateResult = await lateResponse.json();
    expect(lateResult.accepted).toBe(false);
    await expect(competitorPage.getByText("Tim lain lebih dulu")).toBeVisible();

    const finalSnapshot = await (await fetch(`${backendUrl}/api/state`)).json();
    expect(finalSnapshot.revision).toBe(round.revision + 1);
    expect(finalSnapshot.state.buzzerTeamId).toBe("e2e-spam");
  } finally {
    releaseRequests();
    await Promise.all([spamContext.close(), competitorContext.close()]);
  }
});

test("does not save a buzzer claim locally when the backend is offline", async ({ browser }) => {
  const round = await openRound();
  const context = await browser.newContext();

  try {
    const page = await context.newPage();
    await page.routeWebSocket("**/ws", (route) => { void route.close({ code: 1011, reason: "simulated connection loss" }); });
    await page.route("**/api/buzzer", (route) => route.abort());
    await page.goto(`${frontendUrl}/player?team_id=e2e-delayed`);
    await expect(page.getByRole("button", { name: /BUZZ/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /BUZZ/ })).toBeEnabled();
    await page.getByRole("button", { name: /BUZZ/ }).click();
    await expect(page.getByRole("status")).toContainText("Hasil klaim belum dapat dipastikan");
    const cachedState = await page.evaluate(() => JSON.parse(localStorage.getItem("lcc-backend-cache-v1") ?? "null"));
    expect(cachedState.buzzerTeamId).toBeNull();
    expect(cachedState.buzzerTieTeamIds).toEqual([]);
    const finalSnapshot = await (await fetch(`${backendUrl}/api/state`)).json();
    expect(finalSnapshot.revision).toBe(round.revision);
    expect(finalSnapshot.state.buzzerTeamId).toBeNull();
  } finally {
    await context.close();
  }
});
