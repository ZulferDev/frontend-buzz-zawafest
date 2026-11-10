import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createStateStore } from "../src/database.js";
import { createEmptyState } from "../src/state.js";

function setup(buzzerClaimWindowMs = 250) {
  const store = createStateStore();
  return { app: createApp({ store, buzzerStartDelayMs: 0, buzzerClaimWindowMs }), store };
}

function stateWithTeams() {
  return {
    ...createEmptyState(),
    teams: [
      { id: "team-1", name: "Tim Satu", score: 0, soundData: "" },
      { id: "team-2", name: "Tim Dua", score: 5, soundData: "" },
    ],
    questions: [{ id: "question-1", group: "Umum", text: "Pertanyaan?", answer: "Jawaban", value: 10 }],
    currentQuestionId: "question-1",
    rebuttalOpen: true,
  };
}

test("mengambil state awal dengan revision nol", async () => {
  const { app, store } = setup();
  const response = await app.request("/api/state");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.revision, 0);
  assert.deepEqual(body.state.teams, []);
  store.close();
});

test("menyimpan state dan menolak revision yang sudah kedaluwarsa", async () => {
  const { app, store } = setup();
  const state = stateWithTeams();
  const saved = await app.request("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state, expectedRevision: 0 }),
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 1);

  const conflict = await app.request("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state, expectedRevision: 0 }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).latest.revision, 1);
  store.close();
});

test("menganggap klaim berbeda dalam jendela adjudikasi sebagai seri", async () => {
  const { app, store } = setup();
  const saved = await app.request("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: stateWithTeams(), expectedRevision: 0 }),
  });
  assert.equal(saved.status, 200);

  const firstClaim = app.request("/api/buzzer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teamId: "team-1", clientTimestamp: 9999999999999 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const secondClaim = app.request("/api/buzzer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teamId: "team-2", clientTimestamp: 1 }),
  });
  const responses = await Promise.all([firstClaim, secondClaim]);
  const results = await Promise.all(responses.map((response) => response.json()));
  assert.equal(results.filter((result) => result.accepted).length, 2);
  assert.equal(results[0].accepted, true);
  assert.equal(results[1].accepted, true);
  assert.equal(results[0].state.buzzerTeamId, null);
  assert.deepEqual(results[0].state.buzzerTieTeamIds, ["team-1", "team-2"]);
  assert.deepEqual(store.read().state.buzzerTieTeamIds, ["team-1", "team-2"]);

  const current = store.read();
  const invalid = await app.request("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: { ...stateWithTeams(), currentQuestionId: "missing" }, expectedRevision: current.revision }),
  });
  assert.equal(invalid.status, 422);
  store.close();
});

test("membuka jendela baru setelah seri direset", async () => {
  const store = createStateStore();
  const app = createApp({ store, buzzerStartDelayMs: 20, buzzerClaimWindowMs: 20 });
  const opened = await app.request("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: stateWithTeams(), expectedRevision: 0 }),
  });
  await Promise.all(["team-1", "team-2"].map((teamId) => app.request("/api/buzzer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teamId }),
  })));
  const tied = store.read();
  assert.deepEqual(tied.state.buzzerTieTeamIds, ["team-1", "team-2"]);

  const reset = await app.request("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      state: { ...tied.state, buzzerTieTeamIds: [], buzzerTeamId: null },
      expectedRevision: tied.revision,
    }),
  });
  const resetSnapshot = await reset.json();
  assert.equal(reset.status, 200);
  assert.deepEqual(resetSnapshot.state.buzzerTieTeamIds, []);
  assert.ok(resetSnapshot.state.buzzerOpensAt >= Date.now() + 10);

  await new Promise((resolve) => setTimeout(resolve, resetSnapshot.state.buzzerOpensAt - Date.now() + 5));
  const claim = await app.request("/api/buzzer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teamId: "team-1" }),
  });
  const result = await claim.json();
  assert.equal(result.accepted, true);
  assert.equal(result.state.buzzerTeamId, "team-1");
  store.close();
});

test("mendeduplikasi spam per tim dan tidak mengubah hasil dengan klaim yang lebih lambat", async () => {
  const store = createStateStore();
  const app = createApp({ store, buzzerStartDelayMs: 0 });
  const saved = await app.request("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: stateWithTeams(), expectedRevision: 0 }),
  });
  assert.equal(saved.status, 200);

  const spamClaims = Array.from({ length: 12 }, () => app.request("/api/buzzer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teamId: "team-1" }),
  }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const competitorClaim = app.request("/api/buzzer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teamId: "team-2" }),
  });

  const results = await Promise.all([...spamClaims, competitorClaim].map(async (request) => {
    const response = await request;
    assert.equal(response.status, 200);
    return response.json();
  }));
  assert.equal(results.filter((result) => result.accepted).length, 1);
  assert.equal(results.at(-1).accepted, false);
  assert.equal(results.at(-1).state.buzzerTeamId, "team-1");
  assert.equal(store.read().state.buzzerTeamId, "team-1");
  store.close();
});

test("menolak klaim tidak valid tanpa menghalangi klaim valid", async () => {
  const { app, store } = setup();
  await app.request("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: stateWithTeams(), expectedRevision: 0 }),
  });

  const invalidClaim = app.request("/api/buzzer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teamId: null }),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const validClaim = app.request("/api/buzzer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teamId: "team-2" }),
  });
  const [invalidResponse, validResponse] = await Promise.all([invalidClaim, validClaim]);
  assert.equal(invalidResponse.status, 422);
  assert.equal(validResponse.status, 200);
  assert.equal((await validResponse.json()).accepted, true);
  assert.equal(store.read().state.buzzerTeamId, "team-2");
  store.close();
});

test("mendukung polling state berbasis revision tanpa mengirim snapshot yang belum berubah", async () => {
  const store = createStateStore();
  const app = createApp({ store });
  const unchanged = await app.request("/api/state?since=0");
  assert.equal(unchanged.status, 204);
  assert.equal(unchanged.headers.get("cache-control"), "no-store");

  const saved = await app.request("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: stateWithTeams(), expectedRevision: 0 }),
  });
  assert.equal(saved.status, 200);

  const changed = await app.request("/api/state?since=0");
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).revision, 1);

  const latest = await app.request("/api/state?since=1");
  assert.equal(latest.status, 204);

  const invalid = await app.request("/api/state?since=not-a-revision");
  assert.equal(invalid.status, 400);

  store.close();
});

test("menetapkan satu waktu pembukaan server dan menolak klaim buzzer yang terlalu awal", async () => {
  const store = createStateStore();
  const app = createApp({ store, buzzerStartDelayMs: 100, buzzerClaimWindowMs: 0 });
  const opened = await app.request("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: stateWithTeams(), expectedRevision: 0 }),
  });
  const openingSnapshot = await opened.json();
  assert.ok(openingSnapshot.state.buzzerOpensAt >= Date.now() + 50);
  assert.ok(opened.headers.has("x-server-time"));

  const earlyClaim = await app.request("/api/buzzer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teamId: "team-1" }),
  });
  assert.equal((await earlyClaim.json()).accepted, false);
  assert.equal(store.read().revision, openingSnapshot.revision);

  await new Promise((resolve) => setTimeout(resolve, openingSnapshot.state.buzzerOpensAt - Date.now() + 5));
  const onTimeClaim = await app.request("/api/buzzer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teamId: "team-1" }),
  });
  assert.equal((await onTimeClaim.json()).accepted, true);
  store.close();
});

test("mengizinkan origin IP privat frontend dan menolak IP publik otomatis", async () => {
  const store = createStateStore();
  const app = createApp({ store });

  const allowed = await app.request("/api/state", {
    headers: { Origin: "http://192.168.1.42:5173" },
  });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://192.168.1.42:5173");
  assert.match(allowed.headers.get("access-control-expose-headers") ?? "", /X-Server-Time/i);
  assert.ok(allowed.headers.has("x-server-time"));
  assert.ok(Number.isFinite(Number(allowed.headers.get("x-server-time"))));

  const loopback = await app.request("/api/state", {
    headers: { Origin: "http://[::1]:5173" },
  });
  assert.equal(loopback.headers.get("access-control-allow-origin"), "http://[::1]:5173");

  const wrongPort = await app.request("/api/state", {
    headers: { Origin: "http://192.168.1.42:8080" },
  });
  assert.equal(wrongPort.headers.get("access-control-allow-origin"), null);

  const publicIp = await app.request("/api/state", {
    headers: { Origin: "http://8.8.8.8:5173" },
  });
  assert.equal(publicIp.headers.get("access-control-allow-origin"), null);

  store.close();
});
