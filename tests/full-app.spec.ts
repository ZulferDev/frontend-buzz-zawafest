import { expect, test, type BrowserContext, type Download, type Page } from "@playwright/test";
import * as XLSX from "@e965/xlsx";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const backendUrl = process.env.ZAWA_E2E_BACKEND_URL ?? "http://127.0.0.1:3310";
const evidenceDirectory = join(process.cwd(), "test-results", "e2e-evidence");

function createWavBuffer() {
  const sampleRate = 8_000;
  const sampleCount = sampleRate / 4;
  const samples = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    samples.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 4_000), index * 2);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

test("covers the competition workflow across home, admin, quiz, and participant pages", async ({ browser }) => {
  test.setTimeout(90_000);
  mkdirSync(evidenceDirectory, { recursive: true });
  const videoDirectory = join(evidenceDirectory, "videos");
  mkdirSync(videoDirectory, { recursive: true });
  const pageErrors: string[] = [];
  const contexts: BrowserContext[] = [];

  const current = await (await fetch(`${backendUrl}/api/state`)).json();
  const reset = await fetch(`${backendUrl}/api/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      state: {
        version: 1,
        teams: [],
        questions: [],
        currentQuestionId: null,
        rebuttalOpen: false,
        buzzerTeamId: null,
        screen: "question",
        updatedAt: Date.now(),
      },
      expectedRevision: current.revision,
    }),
  });
  expect(reset.ok).toBeTruthy();
  const readBackendState = async () => (await (await fetch(`${backendUrl}/api/state`)).json()).state;
  const readCachedState = (target: Page) => target.evaluate(() => {
    const raw = localStorage.getItem("lcc-backend-cache-v1");
    return raw ? JSON.parse(raw) : null;
  });

  const makePage = async (recordVideo = false) => {
    const browserContext = await browser.newContext({
      acceptDownloads: true,
      ...(recordVideo ? { recordVideo: { dir: videoDirectory } } : {}),
    });
    contexts.push(browserContext);
    return browserContext.newPage();
  };
  const admin = await makePage(true);
  const quiz = await makePage();
  const redPlayer = await makePage();
  const bluePlayer = await makePage();
  const downloads: Download[] = [];
  admin.on("download", (download) => downloads.push(download));
  const page = admin;
  for (const [label, target] of [
    ["admin", admin],
    ["quiz", quiz],
    ["red player", redPlayer],
    ["blue player", bluePlayer],
  ]) {
    target.on("pageerror", (error) => pageErrors.push(`${label}: ${error.message}`));
  }

  await page.goto("/");
    await expect(page.getByRole("heading", { name: /Lomba Cerdas Cermat/ })).toBeVisible();
    await expect(page.getByText("3 langkah mudah", { exact: false })).toHaveCount(0);
    await page.screenshot({ path: join(evidenceDirectory, "01-home.png"), fullPage: true });

    await admin.goto("/admin");
    await expect(admin.locator("#admin-sync-status").getByText("LIVE · TERSINKRON")).toBeVisible();
    await admin.screenshot({ path: join(evidenceDirectory, "02-admin-empty.png"), fullPage: true });

    const audio = {
      name: "buzzer.wav",
      mimeType: "audio/wav",
      buffer: createWavBuffer(),
    };
    const addTeam = async (name: string, sound?: typeof audio) => {
      await admin.locator('[data-form="team"] input[name="name"]').fill(name);
      if (sound) await admin.locator('[data-form="team"] input[name="sound"]').setInputFiles(sound);
      await admin.locator('[data-form="team"] button[type="submit"]').click();
      await expect(admin.locator(".team-row").filter({ hasText: name })).toBeVisible();
    };
    await addTeam("Tim Merah", audio);
    await addTeam("Tim Biru");

    const addQuestion = async (group: string, text: string, answer: string, value: string) => {
      await admin.getByRole("tab", { name: "Tambah manual" }).click();
      await admin.locator('[data-form="question"] input[name="group"]').fill(group);
      await admin.locator('[data-form="question"] textarea[name="text"]').fill(text);
      await admin.locator('[data-form="question"] input[name="answer"]').fill(answer);
      await admin.locator('[data-form="question"] input[name="value"]').fill(value);
      await admin.locator('[data-form="question"] button[type="submit"]').click();
    };
    await addQuestion("IPA", "Apa nama gas yang dibutuhkan manusia untuk bernapas?", "Oksigen", "20");
    await addQuestion("Matematika", "Berapa hasil 6 dikali 7?", "42", "15");
    await expect(admin.locator(".question-row")).toHaveCount(2);

    await admin.locator("#question-group").selectOption({ label: "IPA" });
    await expect(admin.locator(".question-row")).toHaveCount(1);
    await expect(admin.locator(".question-row").getByText("Oksigen")).toBeVisible();
    await admin.locator("#question-group").selectOption("");

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet([
      ["Kelompok", "Teks Soal", "Jawaban", "Poin"],
      ["Sejarah", "Siapa proklamator Indonesia?", "Soekarno dan Hatta", 25],
      ["Sains", "Apa pusat tata surya?", "Matahari", 10],
    ]);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Soal");
    const workbookBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    await admin.getByRole("tab", { name: "Impor / ekspor" }).click();
    await admin.locator("#import-file").setInputFiles({
      name: "soal.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: workbookBuffer,
    });
    await expect(admin.getByRole("status")).toContainText("2 soal berhasil diimpor.");
    await admin.getByRole("tab", { name: "Daftar soal" }).click();
    await expect(admin.locator(".question-row")).toHaveCount(4);
    await admin.locator("#question-group").selectOption({ label: "Sejarah" });
    await expect(admin.locator(".question-row")).toHaveCount(1);
    await expect(admin.locator(".question-row").getByText("Siapa proklamator Indonesia?")).toBeVisible();
    await admin.locator("#question-group").selectOption("");

    await admin.getByRole("tab", { name: "Impor / ekspor" }).click();
    await admin.getByRole("button", { name: "Unduh semua soal (.xlsx)" }).click();
    await expect(admin.getByRole("status")).toContainText("Bank soal berhasil diunduh.");
    await expect.poll(() => downloads.length).toBe(1);
    const exportedBank = downloads[0];
    const exportedBankPath = await exportedBank.path();
    expect(exportedBankPath).toBeTruthy();
    const exportedWorkbook = XLSX.read(readFileSync(exportedBankPath!), { type: "buffer" });
    const bankRows = XLSX.utils.sheet_to_json(exportedWorkbook.Sheets.Soal, { header: 1 });
    expect(bankRows).toHaveLength(5);
    await admin.getByRole("button", { name: "Unduh template kosong" }).click();
    await expect(admin.getByRole("status")).toContainText("Template berhasil diunduh.");
    await expect.poll(() => downloads.length).toBe(2);
    const templateDownload = downloads[1];
    const templatePath = await templateDownload.path();
    expect(templatePath).toBeTruthy();
    const templateWorkbook = XLSX.read(readFileSync(templatePath!), { type: "buffer" });
    expect(XLSX.utils.sheet_to_json(templateWorkbook.Sheets.Soal, { header: 1 })).toHaveLength(1);

    await admin.getByRole("tab", { name: "Daftar soal" }).click();
    await admin.locator(".question-row").filter({ hasText: "Apa nama gas yang dibutuhkan" })
      .getByRole("button", { name: "Pilih soal" }).click();
    await expect(admin.locator(".status-question")).toContainText("Apa nama gas yang dibutuhkan manusia untuk bernapas?");

    await Promise.all([
      quiz.goto("/quiz"),
      redPlayer.goto("/player"),
      bluePlayer.goto("/player"),
    ]);
    await expect(quiz.locator("#sync-status").getByText("LIVE · TERSINKRON")).toBeVisible();
    await expect(quiz.getByText("Apa nama gas yang dibutuhkan manusia untuk bernapas?", { exact: true })).toBeVisible();
    await expect(quiz.locator(".podium-card")).toHaveCount(2);
    await redPlayer.locator("#player-team").selectOption({ label: "Tim Merah" });
    await redPlayer.getByRole("button", { name: /Masuk ke buzzer/ }).click();
    await expect(redPlayer).toHaveURL(/team_id=/);
    await bluePlayer.locator("#player-team").selectOption({ label: "Tim Biru" });
    await bluePlayer.getByRole("button", { name: /Masuk ke buzzer/ }).click();
    await expect(redPlayer.getByText("Menunggu babak rebutan")).toBeVisible();
    await redPlayer.screenshot({ path: join(evidenceDirectory, "03-player-waiting.png"), fullPage: true });

    await admin.getByRole("button", { name: "Buka rebutan" }).click();
    await Promise.all([
      redPlayer.getByRole("button", { name: /BUZZ/ }).waitFor(),
      bluePlayer.getByRole("button", { name: /BUZZ/ }).waitFor(),
    ]);
    await quiz.screenshot({ path: join(evidenceDirectory, "04-quiz-rebutan-open.png"), fullPage: true });
    await Promise.all([
      redPlayer.locator('[data-action="buzz"]').evaluate((button: HTMLButtonElement) => button.click()),
      bluePlayer.locator('[data-action="buzz"]').evaluate((button: HTMLButtonElement) => button.click()),
    ]);

    const winner = await Promise.race([
      redPlayer.getByText("Kamu yang tercepat!").waitFor().then(() => redPlayer),
      bluePlayer.getByText("Kamu yang tercepat!").waitFor().then(() => bluePlayer),
    ]);
    const loser = winner === redPlayer ? bluePlayer : redPlayer;
    await expect(loser.getByText("Tim lain lebih dulu")).toBeVisible();
    await expect(quiz.getByText(/menekan buzzer!/)).toBeVisible();
    await winner.screenshot({ path: join(evidenceDirectory, "05-player-buzzer-winner.png"), fullPage: true });

    await admin.getByRole("button", { name: "Reset buzzer" }).click();
    await expect.poll(async () => {
      const state = await readBackendState();
      return { rebuttalOpen: state.rebuttalOpen, buzzerTeamId: state.buzzerTeamId };
    }).toEqual({ rebuttalOpen: true, buzzerTeamId: null });
    await expect.poll(() => readCachedState(redPlayer), { timeout: 15_000 }).toMatchObject({
      rebuttalOpen: true,
      buzzerTeamId: null,
    });
    await expect.poll(() => readCachedState(bluePlayer), { timeout: 15_000 }).toMatchObject({
      rebuttalOpen: true,
      buzzerTeamId: null,
    });
    await expect(redPlayer.getByRole("button", { name: /BUZZ/ })).toBeVisible({ timeout: 15_000 });
    await expect(bluePlayer.getByRole("button", { name: /BUZZ/ })).toBeVisible({ timeout: 15_000 });
    await admin.getByRole("button", { name: "Tutup rebutan" }).click();
    await expect.poll(async () => (await readBackendState()).rebuttalOpen).toBe(false);
    await expect(redPlayer.getByText("Menunggu babak rebutan")).toBeVisible();
    await admin.getByRole("button", { name: "Buka rebutan" }).click();
    await expect.poll(async () => {
      const state = await readBackendState();
      return { rebuttalOpen: state.rebuttalOpen, buzzerTeamId: state.buzzerTeamId };
    }).toEqual({ rebuttalOpen: true, buzzerTeamId: null });
    await expect.poll(() => readCachedState(redPlayer), { timeout: 15_000 }).toMatchObject({
      rebuttalOpen: true,
      buzzerTeamId: null,
    });
    const redTeamId = await redPlayer.locator('[data-action="buzz"]').getAttribute("data-team");
    await redPlayer.getByRole("button", { name: /BUZZ/ }).click();
    await expect.poll(async () => (await readBackendState()).buzzerTeamId, { timeout: 15_000 }).toBe(redTeamId);
    await expect(redPlayer.getByText("Kamu yang tercepat!")).toBeVisible({ timeout: 15_000 });

    await admin.getByRole("button", { name: "Tambah 10 poin untuk Tim Merah" }).click();
    await expect(redPlayer.locator(".player-score")).toContainText("10");
    await admin.getByRole("button", { name: "Kurangi 5 poin dari Tim Merah" }).click();
    await expect(redPlayer.locator(".player-score")).toContainText("5");
    await admin.getByRole("button", { name: "Tambah 10 poin untuk Tim Biru" }).click();
    await expect(quiz.locator(".podium-card").first()).toContainText("Tim Biru");
    await expect(bluePlayer.locator(".player-score")).toContainText("10");

    await admin.context().route(`${backendUrl}/api/**`, (route) => route.abort());
    await admin.context().setOffline(true);
    await admin.getByRole("button", { name: "Tambah 10 poin untuk Tim Merah" }).click();
    await expect(admin.locator("#admin-sync-status")).toContainText("LOKAL · BACKEND OFFLINE");
    await expect(admin.locator(".team-row").filter({ hasText: "Tim Merah" })).toContainText("15 poin");
    const offlineSnapshot = await (await fetch(`${backendUrl}/api/state`)).json();
    expect(offlineSnapshot.state.teams.find((team: { name: string }) => team.name === "Tim Merah")?.score).toBe(5);
    await admin.screenshot({ path: join(evidenceDirectory, "06-offline-cache.png"), fullPage: true });

    await admin.context().unroute(`${backendUrl}/api/**`);
    await admin.context().setOffline(false);
    await expect(admin.locator("#admin-sync-status")).toContainText("LIVE · TERSINKRON", { timeout: 15_000 });
    await expect.poll(async () => {
      const snapshot = await (await fetch(`${backendUrl}/api/state`)).json();
      return snapshot.state.teams.find((team: { name: string }) => team.name === "Tim Merah")?.score;
    }, { timeout: 15_000 }).toBe(15);
    await expect(redPlayer.locator(".player-score")).toContainText("15");

    await admin.getByRole("button", { name: "Sembunyi / standby" }).click();
    await expect(quiz.getByText("Lomba akan segera dimulai")).toBeVisible();
    await quiz.screenshot({ path: join(evidenceDirectory, "07-quiz-standby.png"), fullPage: true });
    await admin.getByRole("button", { name: "Tampilkan soal" }).click();
    await expect(quiz.getByText("Apa nama gas yang dibutuhkan manusia untuk bernapas?", { exact: true })).toBeVisible();

    await admin.locator("#question-group").selectOption({ label: "Matematika" });
    await admin.locator(".question-row").getByRole("button", { name: "Pilih soal" }).click();
    await expect(quiz.getByText("Berapa hasil 6 dikali 7?", { exact: true })).toBeVisible();
    await admin.locator("#question-group").selectOption("");
    const removeQuestionDialog = admin.waitForEvent("dialog").then((dialog) => dialog.accept());
    await admin.locator(".question-row").filter({ hasText: "Siapa proklamator Indonesia?" })
      .getByRole("button", { name: "Hapus" }).click();
    await removeQuestionDialog;
    await expect(admin.locator(".question-row")).toHaveCount(3);

    expect(pageErrors).toEqual([]);
    await admin.screenshot({ path: join(evidenceDirectory, "08-admin-managed-state.png"), fullPage: true });

    const deleteTeamDialog = admin.waitForEvent("dialog").then((dialog) => dialog.accept());
    await admin.locator(".team-row").filter({ hasText: "Tim Biru" })
      .getByRole("button", { name: "Hapus Tim Biru" }).click();
    await deleteTeamDialog;
    await expect(admin.locator(".team-row")).toHaveCount(1);
    await expect(quiz.locator(".podium-card")).toHaveCount(1);

    const deleteActiveQuestionDialog = admin.waitForEvent("dialog").then((dialog) => dialog.accept());
    await admin.locator(".question-row").filter({ hasText: "Berapa hasil 6 dikali 7?" })
      .getByRole("button", { name: "Hapus" }).click();
    await deleteActiveQuestionDialog;
    await expect(admin.locator(".status-question")).toContainText("Belum ada soal dipilih");

    const resetAllDialog = admin.waitForEvent("dialog").then((dialog) => dialog.accept());
    await admin.getByRole("button", { name: "Reset semua" }).click();
    await resetAllDialog;
    await expect(admin.locator(".team-row")).toHaveCount(0);
    await expect(admin.locator(".question-row")).toHaveCount(0);
    await expect(quiz.getByText("Belum ada tim. Tambahkan tim dari panel admin.")).toBeVisible();
  const finalSnapshot = await (await fetch(`${backendUrl}/api/state`)).json();
  expect(finalSnapshot.state.teams).toEqual([]);
  expect(finalSnapshot.state.questions).toEqual([]);
  expect(finalSnapshot.state.currentQuestionId).toBeNull();
  expect(finalSnapshot.state.rebuttalOpen).toBe(false);
  expect(finalSnapshot.state.buzzerTeamId).toBeNull();
  expect(pageErrors).toEqual([]);
  await Promise.all(contexts.map((browserContext) => browserContext.close()));
});
