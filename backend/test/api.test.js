import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createStateStore } from "../src/database.js";
import { createEmptyState } from "../src/state.js";

function setup() {
  const store = createStateStore();
  return { app: createApp({ store }), store };
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

test("mengunci hanya satu buzzer dan memilih klaim pertama yang diterima server", async () => {
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
  assert.equal(results.filter((result) => result.accepted).length, 1);
  assert.equal(results[0].accepted, true);
  assert.equal(results[1].accepted, false);
  assert.equal(results[0].state.buzzerTeamId, "team-1");
  assert.equal(results[1].state.buzzerTeamId, "team-1");

  const invalid = await app.request("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: { ...stateWithTeams(), currentQuestionId: "missing" }, expectedRevision: 2 }),
  });
  assert.equal(invalid.status, 422);
  store.close();
});

test("mendeduplikasi spam per tim selama jendela dan menerima klaim pesaing yang lebih dulu server", async () => {
  const store = createStateStore();
  const app = createApp({ store });
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
  await new Promise((resolve) => setTimeout(resolve, 10));
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

test("menolak klaim tidak valid tanpa menghalangi klaim valid dalam jendela yang sama", async () => {
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

test("mengizinkan origin IP privat frontend dan menolak IP publik otomatis", async () => {
  const store = createStateStore();
  const app = createApp({ store });

  const allowed = await app.request("/api/state", {
    headers: { Origin: "http://192.168.1.42:5173" },
  });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://192.168.1.42:5173");

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
