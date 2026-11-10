const LEGACY_STORAGE_KEY = "lcc-local-state-v1";
const CACHE_STORAGE_KEY = "lcc-backend-cache-v1";
const CHANGE_EVENT = "lcc-local-state-change";
const defaultBackendUrl = new URL("/api", window.location.origin);
defaultBackendUrl.port = import.meta.env?.VITE_API_PORT || "3000";
const BACKEND_URL = (import.meta.env?.VITE_API_URL || defaultBackendUrl.toString()).replace(/\/+$/, "");
const RECONNECT_DELAY = 3000;
const POLL_INTERVAL = 250;
let serverClockOffset = 0;
let bestClockSyncRtt = Infinity;

let localGeneration = 0;
let backendRevision = -1;
let backendState = null;
let backendReady = false;
let syncBlocked = false;
let connecting = false;
let reconnectTimer;
let pollTimer;
let pollInFlight = false;
let mutationQueue = [];
const statusListeners = new Set();
let backendStatus = { state: "connecting", message: "Menghubungkan ke server..." };

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createEmptyState() {
  return {
    version: 1,
    teams: [],
    questions: [],
    currentQuestionId: null,
    rebuttalOpen: false,
    buzzerOpensAt: null,
    buzzerTeamId: null,
    screen: "question",
    updatedAt: Date.now(),
  };
}

function createStarterState() {
  return {
    ...createEmptyState(),
    teams: [
      { id: makeId("team"), name: "Tim Merah", score: 0, soundData: "" },
      { id: makeId("team"), name: "Tim Biru", score: 0, soundData: "" },
      { id: makeId("team"), name: "Tim Hijau", score: 0, soundData: "" },
    ],
    questions: [
      {
        id: makeId("question"),
        group: "Pengetahuan Umum",
        text: "Apa nama planet terbesar di tata surya?",
        answer: "Jupiter",
        value: 10,
      },
      {
        id: makeId("question"),
        group: "Sains",
        text: "Apa proses tumbuhan membuat makanannya sendiri?",
        answer: "Fotosintesis",
        value: 10,
      },
      {
        id: makeId("question"),
        group: "Matematika",
        text: "Berapa hasil dari 12 dikali 8?",
        answer: "96",
        value: 15,
      },
    ],
  };
}

function isValidState(state) {
  return (
    state &&
    state.version === 1 &&
    Array.isArray(state.teams) &&
    Array.isArray(state.questions) &&
    typeof state.rebuttalOpen === "boolean" &&
    (state.screen === "question" || state.screen === "standby")
  );
}

export function readState() {
  let serialized;
  try {
    serialized = localStorage.getItem(CACHE_STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch (error) {
    throw new Error(`Penyimpanan browser tidak dapat dibaca: ${error.message}`);
  }

  if (serialized === null) {
    const starter = createStarterState();
    writeCache(starter);
    return starter;
  }

  let state;
  try {
    state = JSON.parse(serialized);
  } catch {
    throw new Error("Data LCC di localStorage rusak dan tidak bisa dibaca.");
  }

  if (!isValidState(state)) {
    throw new Error("Format data LCC di localStorage tidak dikenali.");
  }
  return state;
}

function writeState(state) {
  writeCache(state);
}

function writeCache(state) {
  try {
    localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    throw new Error(`Perubahan gagal disimpan di browser: ${error.message}`);
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

function removeLegacyState() {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch (error) {
    console.error("[migration] Data localStorage lama tidak dapat dibersihkan.", error);
  }
}

function commitLocalUpdate(update) {
  const next = structuredClone(readState());
  update(next);
  next.updatedAt = Date.now();
  writeState(next);
  localGeneration += 1;
  return { state: next, generation: localGeneration };
}

async function saveLocalUpdate(update) {
  if (navigator.locks?.request) {
    return navigator.locks.request("lcc-local-state-write", () => commitLocalUpdate(update));
  }
  return commitLocalUpdate(update);
}

export async function updateState(update) {
  const { state, generation } = await saveLocalUpdate(update);
  mutationQueue.push({ type: "state", update, generation });
  syncBlocked = false;
  void flushMutationQueue();
  return state;
}

export async function claimBuzzer(teamId) {
  if (backendReady) {
    try {
      const result = await requestJson(`${BACKEND_URL}/buzzer`, {
        method: "POST",
        body: JSON.stringify({ teamId }),
      });
      acceptSnapshot(result, true);
      return result.accepted;
    } catch (error) {
      if (error.status && error.status < 500) {
        setBackendStatus("error", "KLAIM BUZZER GAGAL");
        throw error;
      }
      markOffline(error);
    }
  }

  const { state, generation } = await saveLocalUpdate((next) => {
    if (next.rebuttalOpen && !next.buzzerTeamId && next.teams.some((team) => team.id === teamId)) {
      next.buzzerTeamId = teamId;
    }
  });
  const accepted = state.buzzerTeamId === teamId;
  if (accepted) {
    mutationQueue.push({ type: "buzzer", teamId, generation });
    void flushMutationQueue();
  }
  return accepted;
}

export function subscribeToStateChanges(callback) {
  const onStorage = (event) => {
    if (event.key === CACHE_STORAGE_KEY || event.key === LEGACY_STORAGE_KEY) callback();
  };
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("focus", callback);
  };
}

export function subscribeToBackendStatus(callback) {
  statusListeners.add(callback);
  callback(backendStatus);
  return () => statusListeners.delete(callback);
}

function setBackendStatus(state, message) {
  backendStatus = { state, message };
  for (const listener of statusListeners) listener(backendStatus);
  window.dispatchEvent(new CustomEvent("lcc-backend-status", { detail: backendStatus }));
}

export function getBackendSyncStatus() {
  return backendStatus;
}

export function getServerTime() {
  return Date.now() + serverClockOffset;
}

async function requestJson(url, options = {}) {
  const requestStartedAt = Date.now();
  const response = await fetch(url, {
    ...options,
    cache: "no-store",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const requestFinishedAt = Date.now();
  const serverTimeHeader = response.headers.get("X-Server-Time");
  const serverTime = serverTimeHeader === null ? Number.NaN : Number(serverTimeHeader);
  const roundTripTime = requestFinishedAt - requestStartedAt;
  if (Number.isFinite(serverTime) && roundTripTime <= bestClockSyncRtt) {
    bestClockSyncRtt = roundTripTime;
    serverClockOffset = serverTime - (requestStartedAt + requestFinishedAt) / 2;
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.message || `Server merespons HTTP ${response.status}.`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function acceptSnapshot(snapshot, applyLocally) {
  if (!snapshot || !Number.isSafeInteger(snapshot.revision) || !isValidState(snapshot.state)) {
    throw new Error("Format respons backend tidak dikenali.");
  }
  if (snapshot.revision < backendRevision) return;

  backendRevision = snapshot.revision;
  backendState = structuredClone(snapshot.state);
  if (applyLocally) writeState(backendState);
}

function markOffline(error) {
  backendReady = false;
  clearTimeout(pollTimer);
  pollTimer = null;
  console.error("[sync] Backend tidak tersedia; perubahan tetap disimpan lokal.", error);
  setBackendStatus("offline", "LOKAL · BACKEND OFFLINE");
  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void initializeBackend();
  }, RECONNECT_DELAY);
}

async function initializeBackend() {
  if (connecting) return;
  connecting = true;
  setBackendStatus("connecting", "MENGHUBUNGKAN...");
  try {
    const snapshot = await requestJson(`${BACKEND_URL}/state`);
    if (snapshot.revision === 0) {
      const local = readState();
      const generation = localGeneration;
      try {
        const seeded = await requestJson(`${BACKEND_URL}/state`, {
          method: "PUT",
          body: JSON.stringify({ state: local, expectedRevision: 0 }),
        });
        acceptSnapshot(seeded, true);
        mutationQueue = mutationQueue.filter((mutation) => mutation.generation > generation);
        removeLegacyState();
      } catch (error) {
        if (error.status !== 409 || !error.body?.latest) throw error;
        acceptSnapshot(error.body.latest, true);
        removeLegacyState();
      }
    } else {
      acceptSnapshot(snapshot, true);
      removeLegacyState();
    }
    backendReady = true;
    setBackendStatus("live", "LIVE · TERSINKRON");
    schedulePoll(0);
    void flushMutationQueue();
  } catch (error) {
    markOffline(error);
  } finally {
    connecting = false;
  }
}

function schedulePoll(delay = POLL_INTERVAL) {
  if (!backendReady || pollTimer) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void pollBackendState();
  }, delay);
}

async function pollBackendState() {
  if (!backendReady || pollInFlight) return;
  pollInFlight = true;
  try {
    const snapshot = await requestJson(`${BACKEND_URL}/state?since=${backendRevision}`);
    if (snapshot) {
      acceptSnapshot(snapshot, true);
      setBackendStatus("live", "LIVE · TERSINKRON");
      void flushMutationQueue();
    }
  } catch (error) {
    markOffline(error);
  } finally {
    pollInFlight = false;
    schedulePoll();
  }
}

async function flushMutationQueue() {
  if (!backendReady || !backendState || syncBlocked || flushMutationQueue.running) return;
  flushMutationQueue.running = true;
  try {
    while (backendReady && !syncBlocked && mutationQueue.length) {
      const mutation = mutationQueue[0];
      if (mutation.type === "buzzer") {
        const result = await requestJson(`${BACKEND_URL}/buzzer`, {
          method: "POST",
          body: JSON.stringify({ teamId: mutation.teamId }),
        });
        mutationQueue.shift();
        acceptSnapshot(result, mutation.generation === localGeneration);
        continue;
      }

      const candidate = structuredClone(backendState);
      mutation.update(candidate);
      candidate.updatedAt = Date.now();
      let snapshot;
      try {
        snapshot = await requestJson(`${BACKEND_URL}/state`, {
          method: "PUT",
          body: JSON.stringify({ state: candidate, expectedRevision: backendRevision }),
        });
      } catch (error) {
        if (error.status === 409 && error.body?.latest) {
          acceptSnapshot(error.body.latest, true);
          continue;
        }
        throw error;
      }
      mutationQueue.shift();
      acceptSnapshot(snapshot, mutation.generation === localGeneration);
    }
  } catch (error) {
    if (error.status && error.status < 500) {
      mutationQueue.shift();
      syncBlocked = true;
      console.error("[sync] Backend menolak perubahan state.", error);
      setBackendStatus("error", "SINKRONISASI GAGAL · PERIKSA DATA");
    } else {
      markOffline(error);
    }
  } finally {
    flushMutationQueue.running = false;
  }
}

export function newId(prefix) {
  return makeId(prefix);
}

void initializeBackend();
