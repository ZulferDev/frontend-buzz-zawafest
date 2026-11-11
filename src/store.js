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
let serverClockAnchor = null;
let backendSocket;
let socketReconnectTimer;
let socketReconnectDelay = 500;
let socketHeartbeat;
let syncRequestId = 0;
const pendingSyncs = new Map();
const pendingClaims = new Map();

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
    buzzerTieTeamIds: [],
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
  if (!backendReady) {
    throw new Error("Buzzer tidak dapat diklaim saat koneksi server terputus. Tunggu hingga tersambung kembali.");
  }

  if (backendSocket?.readyState === WebSocket.OPEN) {
    return new Promise((resolve, reject) => {
      const requestId = `buzz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const clientTimestamp = getServerTime();
      const timeout = setTimeout(() => {
        pendingClaims.delete(requestId);
        reject(new Error("Respons klaim tidak diterima. Hasil klaim belum dapat dipastikan."));
      }, 7000);
      pendingClaims.set(requestId, { resolve, reject, timeout });
      try {
        backendSocket.send(JSON.stringify({
          type: "BUZZ",
          requestId,
          clientId: teamId,
          clientTimestamp,
          clientNormalizedTimestamp: clientTimestamp,
        }));
      } catch (error) {
        clearTimeout(timeout);
        pendingClaims.delete(requestId);
        markOffline(error);
        reject(new Error("Koneksi terputus saat klaim buzzer dikirim. Hasil klaim belum dapat dipastikan."));
      }
    });
  }

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
    throw new Error("Koneksi terputus saat klaim buzzer dikirim. Hasil klaim belum dapat dipastikan.");
  }
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
  if (serverClockAnchor) {
    return serverClockAnchor.serverTime + (performance.now() - serverClockAnchor.monotonicTime);
  }
  return Date.now() + serverClockOffset;
}

export function calibrateClock() {
  if (backendSocket?.readyState !== WebSocket.OPEN) return false;
  const socket = backendSocket;
  const requestId = `sync-${++syncRequestId}`;
  const sample = { wallTime: Date.now(), monotonicTime: performance.now() };
  sample.timeout = setTimeout(() => {
    if (!pendingSyncs.delete(requestId)) return;
    if (backendSocket === socket && socket.readyState === WebSocket.OPEN) socket.close();
  }, 5000);
  pendingSyncs.set(requestId, sample);
  try {
    socket.send(JSON.stringify({
      type: "SYNC_TIME",
      requestId,
      clientTime: sample.wallTime,
      clientMonotonic: sample.monotonicTime,
    }));
  } catch (error) {
    clearTimeout(sample.timeout);
    pendingSyncs.delete(requestId);
    console.error("[sync] Kalibrasi jam gagal dikirim.", error);
    socket.close();
    return false;
  }
  return true;
}

async function requestJson(url, options = {}) {
  const requestStartedAt = Date.now();
  const requestStartedMonotonic = performance.now();
  const response = await fetch(url, {
    ...options,
    cache: "no-store",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const requestFinishedAt = Date.now();
  const requestFinishedMonotonic = performance.now();
  const serverTimeHeader = response.headers.get("X-Server-Time");
  const serverTime = serverTimeHeader === null ? Number.NaN : Number(serverTimeHeader);
  const roundTripTime = requestFinishedAt - requestStartedAt;
  if (Number.isFinite(serverTime) && roundTripTime <= bestClockSyncRtt) {
    bestClockSyncRtt = roundTripTime;
    serverClockOffset = serverTime - (requestStartedAt + requestFinishedAt) / 2;
    serverClockAnchor = {
      serverTime,
      monotonicTime: (requestStartedMonotonic + requestFinishedMonotonic) / 2,
    };
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
  if (backendSocket) backendSocket.close();
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

function getWebSocketUrl() {
  const url = new URL(BACKEND_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function scheduleSocketReconnect() {
  if (!backendReady || socketReconnectTimer) return;
  const delay = socketReconnectDelay + Math.random() * Math.min(socketReconnectDelay / 4, 500);
  socketReconnectDelay = Math.min(socketReconnectDelay * 2, 5000);
  socketReconnectTimer = setTimeout(() => {
    socketReconnectTimer = null;
    connectBackendSocket();
  }, delay);
}

function rejectPendingClaims() {
  for (const pending of pendingClaims.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error("Koneksi terputus saat klaim buzzer dikirim. Hasil klaim belum dapat dipastikan."));
  }
  pendingClaims.clear();
}

function handleSocketMessage(event) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch (error) {
    console.error("[sync] Pesan WebSocket tidak valid.", error);
    return;
  }
  if (message.type === "SYNC_ACK") {
    const sample = pendingSyncs.get(message.requestId);
    pendingSyncs.delete(message.requestId);
    if (sample) clearTimeout(sample.timeout);
    if (!sample || !Number.isFinite(message.serverTime)) return;
    const now = performance.now();
    const roundTripTime = now - sample.monotonicTime;
    if (roundTripTime <= bestClockSyncRtt) {
      bestClockSyncRtt = roundTripTime;
      serverClockOffset = message.serverTime - (sample.wallTime + roundTripTime / 2);
      serverClockAnchor = {
        serverTime: message.serverTime,
        monotonicTime: sample.monotonicTime + roundTripTime / 2,
      };
    }
    return;
  }
  if (message.type === "STATE" && message.snapshot) {
    try {
      acceptSnapshot(message.snapshot, true);
      setBackendStatus("live", "LIVE · TERSINKRON");
      void flushMutationQueue();
    } catch (error) {
      console.error("[sync] Snapshot WebSocket tidak valid.", error);
    }
    return;
  }
  if (message.type === "BUZZ_ACK" && typeof message.requestId === "string") {
    const pending = pendingClaims.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingClaims.delete(message.requestId);
    try {
      if (message.snapshot) acceptSnapshot(message.snapshot, true);
      pending.resolve(Boolean(message.accepted));
    } catch (error) {
      pending.reject(error);
    }
  }
}

function connectBackendSocket() {
  if (!backendReady || (backendSocket
    && (backendSocket.readyState === WebSocket.OPEN || backendSocket.readyState === WebSocket.CONNECTING))) {
    return;
  }
  let socket;
  try {
    socket = new WebSocket(getWebSocketUrl());
    backendSocket = socket;
  } catch (error) {
    console.error("[sync] WebSocket tidak dapat dibuat.", error);
    setBackendStatus("error", "KONEKSI LIVE TERPUTUS · MENYAMBUNG ULANG");
    schedulePoll();
    scheduleSocketReconnect();
    return;
  }
  socket.addEventListener("open", () => {
    if (backendSocket !== socket || !backendReady) return;
    socketReconnectDelay = 500;
    clearTimeout(socketReconnectTimer);
    socketReconnectTimer = null;
    clearTimeout(pollTimer);
    pollTimer = null;
    setBackendStatus("live", "LIVE · TERSINKRON");
    calibrateClock();
    clearInterval(socketHeartbeat);
    socketHeartbeat = setInterval(calibrateClock, 15_000);
  });
  socket.addEventListener("message", handleSocketMessage);
  socket.addEventListener("close", () => {
    if (backendSocket !== socket) return;
    backendSocket = null;
    clearInterval(socketHeartbeat);
    socketHeartbeat = null;
    rejectPendingClaims();
    for (const sample of pendingSyncs.values()) clearTimeout(sample.timeout);
    pendingSyncs.clear();
    if (backendReady) {
      setBackendStatus("error", "KONEKSI LIVE TERPUTUS · MENYAMBUNG ULANG");
      schedulePoll(0);
      scheduleSocketReconnect();
    }
  });
  socket.addEventListener("error", () => socket.close());
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
    setBackendStatus("connecting", "MENYAMBUNGKAN LIVE...");
    connectBackendSocket();
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
  if (backendSocket?.readyState === WebSocket.OPEN) return;
  pollInFlight = true;
  try {
    const snapshot = await requestJson(`${BACKEND_URL}/state?since=${backendRevision}`);
    if (snapshot) {
      acceptSnapshot(snapshot, true);
      setBackendStatus(
        backendSocket?.readyState === WebSocket.OPEN ? "live" : "error",
        backendSocket?.readyState === WebSocket.OPEN
          ? "LIVE · TERSINKRON"
          : "WEBSOCKET TERPUTUS · MENYAMBUNG ULANG",
      );
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
