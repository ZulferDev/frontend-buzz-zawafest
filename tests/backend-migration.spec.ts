import { expect, test } from "@playwright/test";

const frontendUrl = process.env.ZAWA_E2E_FRONTEND_URL ?? "http://127.0.0.1:5174";
const backendUrl = process.env.ZAWA_E2E_BACKEND_URL ?? "http://127.0.0.1:3310";
const legacyStorageKey = "lcc-local-state-v1";
const cacheStorageKey = "lcc-backend-cache-v1";

test("migrates legacy browser data to SQLite and synchronizes admin, quiz, and players", async ({ browser }) => {
  const legacyState = {
    version: 1,
    teams: [
      { id: "legacy-red", name: "Tim Legacy Merah", score: 20, soundData: "" },
      { id: "legacy-blue", name: "Tim Legacy Biru", score: 15, soundData: "" },
    ],
    questions: [
      {
        id: "legacy-question",
        group: "Migrasi",
        text: "Apakah data lama sudah berpindah?",
        answer: "Sudah",
        value: 25,
      },
    ],
    currentQuestionId: "legacy-question",
    rebuttalOpen: false,
    buzzerTeamId: null,
    screen: "question",
    updatedAt: 1,
  };
  const errors: string[] = [];
  const adminContext = await browser.newContext();
  await adminContext.addInitScript(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key: legacyStorageKey, value: legacyState },
  );
  const admin = await adminContext.newPage();
  admin.on("pageerror", (error) => errors.push(`admin: ${error.message}`));

  const quizContext = await browser.newContext();
  const quiz = await quizContext.newPage();
  quiz.on("pageerror", (error) => errors.push(`quiz: ${error.message}`));
  const redPlayerContext = await browser.newContext();
  const redPlayer = await redPlayerContext.newPage();
  redPlayer.on("pageerror", (error) => errors.push(`red player: ${error.message}`));
  const bluePlayerContext = await browser.newContext();
  const bluePlayer = await bluePlayerContext.newPage();
  bluePlayer.on("pageerror", (error) => errors.push(`blue player: ${error.message}`));
  const playerWebSockets: string[] = [];
  let redPlayerNavigations = 0;
  let bluePlayerNavigations = 0;
  for (const player of [redPlayer, bluePlayer]) {
    player.on("websocket", (websocket) => playerWebSockets.push(websocket.url()));
  }
  redPlayer.on("framenavigated", (frame) => {
    if (frame === redPlayer.mainFrame()) redPlayerNavigations += 1;
  });
  bluePlayer.on("framenavigated", (frame) => {
    if (frame === bluePlayer.mainFrame()) bluePlayerNavigations += 1;
  });

  try {
    await admin.goto(`${frontendUrl}/admin`);
    await admin.locator("#admin-sync-status").getByText("LIVE · TERSINKRON").waitFor();

    const migrated = await admin.evaluate(({ legacyKey, cacheKey }) => ({
      legacy: localStorage.getItem(legacyKey),
      cache: JSON.parse(localStorage.getItem(cacheKey) || "null"),
    }), { legacyKey: legacyStorageKey, cacheKey: cacheStorageKey });
    expect(migrated.legacy).toBeNull();
    expect(migrated.cache.teams).toEqual(legacyState.teams);
    expect(await (await fetch(`${backendUrl}/api/state`)).json()).toMatchObject({
      revision: 1,
      state: {
        teams: legacyState.teams,
        questions: legacyState.questions,
        currentQuestionId: legacyState.currentQuestionId,
      },
    });

    await Promise.all([
      quiz.goto(`${frontendUrl}/quiz`),
      redPlayer.goto(`${frontendUrl}/player?team_id=legacy-red`),
      bluePlayer.goto(`${frontendUrl}/player?team_id=legacy-blue`),
    ]);
    await quiz.locator("#sync-status").getByText("LIVE · TERSINKRON").waitFor();
    await expect(quiz.getByText("Apakah data lama sudah berpindah?", { exact: true })).toBeVisible();
    await expect(redPlayer.getByText("Tim Legacy Merah", { exact: true })).toBeVisible();
    await expect(bluePlayer.getByText("Tim Legacy Biru", { exact: true })).toBeVisible();

    await admin.locator('[data-form="team"] input[name="name"]').fill("Tim Backend");
    await admin.locator('[data-form="team"] button[type="submit"]').click();
    await expect(quiz.getByText("Tim Backend", { exact: true })).toBeVisible();
    const backendState = await (await fetch(`${backendUrl}/api/state`)).json();
    const newTeam = backendState.state.teams.find((team: { name: string }) => team.name === "Tim Backend");
    expect(newTeam).toBeDefined();

    await admin.getByRole("button", { name: "Buka rebutan" }).click();
    const buzzButton = { name: /BUZZ/ };
    await expect.poll(async () => {
      const snapshot = await (await fetch(`${backendUrl}/api/state`)).json();
      return snapshot.state.buzzerOpensAt;
    }).toBeGreaterThan(Date.now() + 1000);
    await expect(redPlayer.getByRole("button", buzzButton)).toBeHidden();
    await expect(bluePlayer.getByRole("button", buzzButton)).toBeHidden();
    const buttonReadyAt = await Promise.all([
      redPlayer.getByRole("button", buzzButton).waitFor().then(() => redPlayer.evaluate(() => Date.now())),
      bluePlayer.getByRole("button", buzzButton).waitFor().then(() => bluePlayer.evaluate(() => Date.now())),
    ]);
    expect(Math.abs(buttonReadyAt[0] - buttonReadyAt[1])).toBeLessThan(750);
    await Promise.all([
      expect(redPlayer.getByRole("button", buzzButton)).toBeEnabled(),
      expect(bluePlayer.getByRole("button", buzzButton)).toBeEnabled(),
    ]);
    expect(redPlayerNavigations).toBe(1);
    expect(bluePlayerNavigations).toBe(1);
    expect(playerWebSockets.filter((url) => url.includes(new URL(backendUrl).host))).toEqual([]);
    await Promise.all([
      redPlayer.getByRole("button", buzzButton).click(),
      bluePlayer.getByRole("button", buzzButton).click(),
    ]);

    const winner = await Promise.race([
      redPlayer.getByText("Kamu yang tercepat!").waitFor().then(() => redPlayer),
      bluePlayer.getByText("Kamu yang tercepat!").waitFor().then(() => bluePlayer),
    ]);
    const loser = winner === redPlayer ? bluePlayer : redPlayer;
    await expect(loser.getByText("Tim lain lebih dulu")).toBeVisible();
    const finalState = await (await fetch(`${backendUrl}/api/state`)).json();
    expect(finalState.state.buzzerTeamId).toBe(winner === redPlayer ? "legacy-red" : "legacy-blue");
    await expect(quiz.getByText(/menekan buzzer!/)).toBeVisible();

    const winnerName = winner === redPlayer ? "Tim Legacy Merah" : "Tim Legacy Biru";
    const winnerScore = winner === redPlayer ? "30" : "25";
    await admin.getByRole("button", { name: `Tambah 10 poin untuk ${winnerName}` }).click();
    await expect(quiz.locator(".podium-card").filter({ hasText: winnerName }).locator(".podium-score")).toHaveText(winnerScore);
    await expect(winner.locator(".player-score")).toContainText(winnerScore);

    await quiz.evaluate(() => localStorage.clear());
    await quiz.reload();
    await expect(quiz.locator("#sync-status").getByText("LIVE · TERSINKRON")).toBeVisible();
    await expect(quiz.getByText("Apakah data lama sudah berpindah?", { exact: true })).toBeVisible();
    await expect(quiz.locator(".podium-card").filter({ hasText: winnerName }).locator(".podium-score")).toHaveText(winnerScore);
    expect(errors).toEqual([]);
  } finally {
    await Promise.all([
      adminContext.close(),
      quizContext.close(),
      redPlayerContext.close(),
      bluePlayerContext.close(),
    ]);
  }
});
