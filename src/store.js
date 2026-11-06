const STORAGE_KEY = "lcc-local-state-v1";
const CHANGE_EVENT = "lcc-local-state-change";

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
    serialized = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    throw new Error(`Penyimpanan browser tidak dapat dibaca: ${error.message}`);
  }

  if (serialized === null) {
    const starter = createStarterState();
    writeState(starter);
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
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    throw new Error(`Perubahan gagal disimpan di browser: ${error.message}`);
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export async function updateState(update) {
  const commit = () => {
    const next = structuredClone(readState());
    update(next);
    next.updatedAt = Date.now();
    writeState(next);
    return next;
  };

  if (navigator.locks?.request) {
    return navigator.locks.request("lcc-local-state-write", commit);
  }
  return commit();
}

export function subscribeToStateChanges(callback) {
  const onStorage = (event) => {
    if (event.key === STORAGE_KEY) callback();
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

export function newId(prefix) {
  return makeId(prefix);
}
