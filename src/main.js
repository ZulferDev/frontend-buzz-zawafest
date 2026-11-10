import * as XLSX from "@e965/xlsx";
import {
  createEmptyState,
  claimBuzzer,
  getBackendSyncStatus,
  getServerTime,
  newId,
  readState,
  subscribeToBackendStatus,
  subscribeToStateChanges,
  updateState,
} from "./store.js";
import "./styles.css";

const app = document.querySelector("#app");
const route = window.location.pathname.replace(/\/+$/, "") || "/";
const page = route === "/admin"
  ? "admin"
  : route === "/quiz"
    ? "quiz"
    : route === "/player"
      ? "player"
      : "home";

let activeTab = "questions";
let questionGroupFilter = "";
let toastMessage = "";
let toastVisible = false;
let toastTimer;
let lastBuzzId = null;
let audioContext;
let buzzerStartTimer;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function formatScore(score) {
  return new Intl.NumberFormat("id-ID").format(Number(score) || 0);
}

function getCurrentQuestion(state) {
  return state.questions.find((question) => question.id === state.currentQuestionId) ?? null;
}

function renderBackendStatus(status) {
  for (const element of document.querySelectorAll("#sync-status, #admin-sync-status")) {
    if (element.lastChild) element.lastChild.textContent = ` ${status.message}`;
    const live = status.state === "live";
    const error = status.state === "error";
    element.style.backgroundColor = live ? "#f0f8f4" : error ? "#fff0f0" : "#fff5e8";
    element.style.color = live ? "#318263" : error ? "#a6383e" : "#96621e";
    const dot = element.querySelector("i");
    if (dot) dot.style.backgroundColor = live ? "#5de0a6" : error ? "#df6268" : "#e7a53f";
  }
}

function showToast(message, isError = false) {
  toastMessage = message;
  toastVisible = true;
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast-message${isError ? " is-error" : ""}`;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastVisible = false;
    toast.hidden = true;
  }, 3600);
}

function sharedShell(content, className = "") {
  return `
    <div class="app-shell ${className}">
      <header class="topbar">
        <a class="brand" href="/">
          <span class="brand-mark" aria-hidden="true">Z</span>
          <span><strong>ZAWA SMART COMPETITION</strong><small>LOMBA CERDAS CERMAT</small></span>
        </a>
        <nav class="topnav" aria-label="Navigasi utama">
          ${page === "admin" ? '<a href="/admin" class="is-current">Panel admin</a>' : ""}
          <a href="/quiz" class="${page === "quiz" ? "is-current" : ""}">Papan skor</a>
          ${page === "home" ? '<a href="#cara-bermain">Cara bermain</a>' : ""}
          <a class="nav-join" href="/player">${page === "player" ? "Pilih tim" : "Gabung sebagai peserta"}</a>
        </nav>
      </header>
      ${content}
      <div id="toast" class="toast-message" role="status" aria-live="polite" ${toastVisible ? "" : "hidden"}>${escapeHtml(toastMessage)}</div>
      <footer class="app-footer"><span id="sync-status" class="sync-pill"><i></i> MENGHUBUNGKAN...</span><br />Data tersimpan di browser ini dan disinkronkan langsung ke layar lain saat server tersedia.</footer>
    </div>
  `;
}

function renderHome(state) {
  app.innerHTML = sharedShell(`
    <main class="home-content">
      <section class="hero-panel home-hero">
        <div class="hero-copy">
          <div class="eyebrow"><span class="live-dot"></span> ZAWA SMART COMPETITION</div>
          <h1>Lomba Cerdas<br /><span>Cermat</span></h1>
          <p class="hero-slogan">Smart Generation Empower Ummah</p>
          <p class="hero-description">Tunjukkan wawasan, kekompakan, dan kecepatan timmu. Pilih tim untuk bergabung dan bersiap menjadi juara.</p>
          <div class="hero-cta">
            <a class="button button-primary" href="/player">Gabung sebagai peserta <span aria-hidden="true">→</span></a>
            <a class="button button-hero-outline" href="/quiz">Lihat papan skor <span aria-hidden="true">↗</span></a>
          </div>
          <div class="participant-proof"><span class="proof-avatars" aria-hidden="true"><i>✦</i><i>✦</i><i>✦</i></span><span><strong>${state.teams.length} tim siap bertanding</strong><small>Keseruan dimulai dari sini</small></span></div>
        </div>
        <div class="hero-art" aria-hidden="true">
          <div class="art-orbit orbit-outer"></div><div class="art-orbit orbit-inner"></div>
          <div class="art-star star-one">✦</div><div class="art-star star-two">✧</div>
          <div class="trophy-card"><span class="trophy-glow"></span><span class="trophy-icon">🏆</span><span class="trophy-label">BE READY<br /><strong>TO COMPETE</strong></span></div>
          <div class="art-caption"><span class="caption-dot"></span> THINK · BUZZ · WIN</div>
        </div>
      </section>
      <section class="participant-section" id="cara-bermain">
        <div class="section-heading">
          <div><div class="section-kicker">SAATNYA TUNJUKKAN KEMAMPUANMU</div><h2>Satu lomba, banyak kesempatan.</h2><p>Ikuti setiap babak dan jadilah bagian dari keseruan kompetisi.</p></div>
          <a class="section-link" href="/quiz">Pantau papan skor <span aria-hidden="true">↗</span></a>
        </div>
        <div class="participant-grid">
          <article class="participant-card"><span class="participant-step">01</span><span class="participant-icon icon-team" aria-hidden="true">♧</span><h3>Pilih timmu</h3><p>Masuk sebagai peserta dan pilih nama tim yang akan kamu wakili.</p></article>
          <article class="participant-card"><span class="participant-step">02</span><span class="participant-icon icon-buzz" aria-hidden="true">ϟ</span><h3>Siaga untuk rebutan</h3><p>Perhatikan soal di layar dan bersiap tekan buzzer saat babak dibuka.</p></article>
          <article class="participant-card"><span class="participant-step">03</span><span class="participant-icon icon-win" aria-hidden="true">✦</span><h3>Raih poin, jadi juara</h3><p>Jawab dengan tepat, kumpulkan poin, dan pantau posisi timmu.</p></article>
        </div>
        <div class="join-banner"><div><span class="banner-kicker">KOMPETISI MENUNGGUMU</span><h2>Siap membawa timmu menuju kemenangan?</h2><p>Masuk sekarang, pilih tim, dan bersiap untuk babak berikutnya.</p></div><a class="button button-banner" href="/player">Masuk sebagai peserta <span aria-hidden="true">→</span></a></div>
      </section>
    </main>
  `);
}

function renderTeamRows(state) {
  if (!state.teams.length) {
    return `<div class="empty-state"><span>♙</span><strong>Belum ada tim</strong><small>Tambahkan tim untuk memulai kuis.</small></div>`;
  }
  return state.teams.map((team, index) => `
    <div class="team-row">
      <div class="team-identity">
        <span class="team-index">${String(index + 1).padStart(2, "0")}</span>
        <span><strong>${escapeHtml(team.name)}</strong><small>${formatScore(team.score)} poin</small></span>
      </div>
      <div class="team-actions">
        <button class="icon-button score-plus" type="button" data-action="score" data-team="${team.id}" data-value="10" aria-label="Tambah 10 poin untuk ${escapeHtml(team.name)}">+10</button>
        <button class="icon-button score-minus" type="button" data-action="score" data-team="${team.id}" data-value="-5" aria-label="Kurangi 5 poin dari ${escapeHtml(team.name)}">−5</button>
        <button class="icon-button delete-icon" type="button" data-action="delete-team" data-team="${team.id}" aria-label="Hapus ${escapeHtml(team.name)}">×</button>
      </div>
    </div>
  `).join("");
}

function renderQuestionRows(state) {
  const visibleQuestions = state.questions.filter((question) => {
    return !questionGroupFilter || question.group === questionGroupFilter;
  });
  if (!visibleQuestions.length) {
    return `<div class="empty-state"><span>✳</span><strong>${state.questions.length ? "Tidak ada soal di kelompok ini" : "Bank soal masih kosong"}</strong><small>Tambahkan soal manual atau impor dari berkas Excel.</small></div>`;
  }

  return visibleQuestions.map((question) => {
    const active = question.id === state.currentQuestionId;
    return `
      <article class="question-row ${active ? "is-active" : ""}">
        <div class="question-copy">
          <div class="question-meta"><span class="tag">${escapeHtml(question.group || "Umum")}</span><span>${formatScore(question.value)} poin</span>${active ? '<span class="tag tag-active">SEDANG AKTIF</span>' : ""}</div>
          <h3>${escapeHtml(question.text)}</h3>
          ${question.answer ? `<p>Jawaban: <strong>${escapeHtml(question.answer)}</strong></p>` : ""}
        </div>
        <div class="question-actions">
          <button type="button" class="button button-small ${active ? "button-muted" : "button-outline"}" data-action="set-question" data-question="${question.id}" ${active ? "disabled" : ""}>${active ? "Aktif" : "Pilih soal"}</button>
          <button type="button" class="button button-small button-danger-outline" data-action="delete-question" data-question="${question.id}">Hapus</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderAdmin(state) {
  const currentQuestion = getCurrentQuestion(state);
  const tiedTeamIds = state.buzzerTieTeamIds ?? [];
  const buzzerStatus = tiedTeamIds.length
    ? `Seri: ${tiedTeamIds.map((id) => state.teams.find((team) => team.id === id)?.name || id).join(", ")}`
    : state.teams.find((team) => team.id === state.buzzerTeamId)?.name || "Belum ada";
  const groups = [...new Set(state.questions.map((question) => question.group).filter(Boolean))].sort();
  const filteredCount = state.questions.filter((question) => !questionGroupFilter || question.group === questionGroupFilter).length;
  const tabs = [
    ["questions", "Daftar soal"],
    ["add", "Tambah manual"],
    ["import", "Impor / ekspor"],
  ];

  app.innerHTML = sharedShell(`
    <main class="page-content admin-page">
      <div class="page-heading">
        <div><div class="section-kicker">RUANG KENDALI</div><h1>Panel admin</h1><p>Semua kendali lomba dalam satu tempat.</p></div>
        <a class="button button-dark" href="/quiz" target="_blank" rel="noreferrer">Buka layar kuis <span aria-hidden="true">↗</span></a>
      </div>

      <section class="control-card">
        <div class="card-title-row"><div><div class="section-kicker">STATUS LANGSUNG</div><h2>Kendali kuis</h2></div><span class="sync-pill" id="admin-sync-status"><i></i> MENGHUBUNGKAN...</span></div>
        <div class="status-grid">
          <div class="status-cell status-question"><span>SOAL AKTIF</span><strong>${escapeHtml(currentQuestion?.text || "Belum ada soal dipilih")}</strong></div>
          <div class="status-cell"><span>BUZZER</span><strong class="${state.buzzerTeamId || tiedTeamIds.length ? "text-red" : "text-blue"}">${escapeHtml(buzzerStatus)}</strong></div>
          <div class="status-cell"><span>REBUTAN</span><strong class="${state.rebuttalOpen ? "text-green" : "text-muted"}">${state.rebuttalOpen ? "TERBUKA" : "TERTUTUP"}</strong></div>
          <div class="status-cell"><span>LAYAR</span><strong class="text-blue">${state.screen === "standby" ? "STANDBY" : "SOAL"}</strong></div>
        </div>
        <div class="control-actions">
          <button class="button ${state.rebuttalOpen ? "button-warning" : "button-success"}" type="button" data-action="toggle-rebuttal">${state.rebuttalOpen ? "Tutup rebutan" : "Buka rebutan"}</button>
          <button class="button button-outline" type="button" data-action="reset-buzzer">Reset buzzer</button>
          <button class="button button-outline" type="button" data-action="toggle-screen">${state.screen === "standby" ? "Tampilkan soal" : "Sembunyi / standby"}</button>
          <button class="button button-danger-outline" type="button" data-action="reset-all">Reset semua</button>
        </div>
      </section>

      <div class="admin-columns">
        <section class="control-card question-manager">
          <div class="card-title-row"><div><div class="section-kicker">BANK PERTANYAAN</div><h2>Kelola soal</h2></div><span class="count-pill">${state.questions.length} soal</span></div>
          <div class="tabs" role="tablist">
            ${tabs.map(([id, label]) => `<button type="button" role="tab" class="tab-button ${activeTab === id ? "is-active" : ""}" data-tab="${id}" aria-selected="${activeTab === id}">${label}</button>`).join("")}
          </div>
          ${activeTab === "questions" ? `
            <div class="filter-row">
              <label class="sr-only" for="question-group">Filter kelompok soal</label>
              <select id="question-group" class="input-control" data-action="filter-group">
                <option value="">Semua kelompok · ${state.questions.length} soal</option>
                ${groups.map((group) => `<option value="${escapeHtml(group)}" ${questionGroupFilter === group ? "selected" : ""}>${escapeHtml(group)}</option>`).join("")}
              </select>
              <span>${filteredCount} ditampilkan</span>
            </div>
            <div class="question-list">${renderQuestionRows(state)}</div>
          ` : ""}
          ${activeTab === "add" ? `
            <form class="stack-form" data-form="question">
              <label>Kelompok <span>(opsional)</span><input class="input-control" name="group" placeholder="Contoh: Pengetahuan umum" /></label>
              <label>Teks soal<textarea class="input-control" name="text" rows="4" placeholder="Tulis pertanyaan..." required></textarea></label>
              <label>Jawaban <span>(opsional)</span><input class="input-control" name="answer" placeholder="Jawaban singkat" /></label>
              <label>Nilai poin<input class="input-control" name="value" type="number" min="0" step="1" value="10" required /></label>
              <button class="button button-primary" type="submit">Tambahkan soal</button>
            </form>
          ` : ""}
          ${activeTab === "import" ? `
            <div class="import-panel">
              <div class="import-intro"><span class="import-icon">↥</span><div><h3>Impor soal dari Excel</h3><p>Pilih file .xlsx dengan kolom Kelompok, Teks Soal, Jawaban, dan Poin.</p></div></div>
              <label class="upload-zone">Pilih file Excel (.xlsx)<input type="file" id="import-file" accept=".xlsx,.xls" /></label>
              <div class="divider-label">EKSPOR BANK SOAL</div>
              <button class="button button-outline full-width" type="button" data-action="export-questions">Unduh semua soal (.xlsx)</button>
              <button class="text-button" type="button" data-action="export-template">Unduh template kosong</button>
            </div>
          ` : ""}
        </section>

        <aside class="control-card team-manager">
          <div class="card-title-row"><div><div class="section-kicker">PESERTA</div><h2>Kelola tim</h2></div><span class="count-pill">${state.teams.length} tim</span></div>
          <form class="add-team-form" data-form="team">
            <label class="sr-only" for="team-name">Nama tim</label>
            <input id="team-name" class="input-control" name="name" placeholder="Nama tim baru" required />
            <label class="file-label">Nada buzzer <span>(opsional, MP3/WAV)</span><input type="file" name="sound" accept="audio/mpeg,audio/wav,.mp3,.wav" /></label>
            <button class="button button-primary full-width" type="submit">+ Tambah tim</button>
          </form>
          <div class="team-list-heading"><span>DAFTAR TIM</span><span>SKOR</span></div>
          <div class="team-list">${renderTeamRows(state)}</div>
          <div class="score-hint"><b>+10</b> tambah poin <b>−5</b> kurangi poin</div>
        </aside>
      </div>
    </main>
  `, "admin-shell");
}

function renderQuiz(state) {
  const question = getCurrentQuestion(state);
  const buzzedTeam = state.teams.find((team) => team.id === state.buzzerTeamId);
  const tiedTeams = state.buzzerTieTeamIds ?? [];
  const rankedTeams = [...state.teams].sort((a, b) => b.score - a.score);
  let alert;
  if (!state.rebuttalOpen) {
    alert = `<div class="quiz-alert alert-wait"><span class="alert-icon">◷</span><strong>Babak rebutan belum dibuka</strong></div>`;
  } else if (tiedTeams.length) {
    const teamNames = tiedTeams.map((id) => state.teams.find((team) => team.id === id)?.name || id).join(", ");
    alert = `<div class="quiz-alert alert-hit"><span class="alert-icon">ϟ</span><strong>Klaim bersamaan: ${escapeHtml(teamNames)}</strong><span>Babak seri — gunakan soal tie-break.</span></div>`;
  } else if (buzzedTeam) {
    alert = `<div class="quiz-alert alert-hit"><span class="alert-icon">ϟ</span><strong>${escapeHtml(buzzedTeam.name)} menekan buzzer!</strong></div>`;
  } else {
    alert = `<div class="quiz-alert alert-open"><span class="alert-icon">ϟ</span><strong>Rebutan dibuka</strong><span>Tekan tombol tim Anda sekarang</span></div>`;
  }

  if (lastBuzzId !== state.buzzerTeamId && state.buzzerTeamId) {
    lastBuzzId = state.buzzerTeamId;
    playTone(680, 0.22);
  } else if (!state.buzzerTeamId) {
    lastBuzzId = null;
  }

  app.innerHTML = sharedShell(`
    <main class="quiz-page">
      <div class="quiz-title-row"><div><div class="section-kicker">PAPAN PERINGKAT</div><h1>Lomba cerdas cermat</h1></div><span class="live-badge"><i></i> LIVE</span></div>
      ${rankedTeams.length ? `
        <section class="podium-grid" aria-label="Skor tim">
          ${rankedTeams.map((team, index) => `
            <article class="podium-card ${team.id === state.buzzerTeamId || tiedTeams.includes(team.id) ? "is-buzzed" : ""} ${index === 0 ? "is-leader" : ""}">
              <span class="podium-place">${String(index + 1).padStart(2, "0")}</span>
              <div class="podium-name">${escapeHtml(team.name)}</div>
              <strong class="podium-score">${formatScore(team.score)}</strong>
              <span class="podium-unit">POIN</span>
            </article>
          `).join("")}
        </section>
      ` : `<div class="quiz-empty">Belum ada tim. Tambahkan tim dari panel admin.</div>`}

      <section class="question-stage ${state.rebuttalOpen ? "is-open" : ""}">
        <div class="stage-topline"><span>PERTANYAAN</span><span>${question ? escapeHtml(question.group || "UMUM") : "MENUNGGU SOAL"}</span></div>
        ${state.screen === "standby"
          ? `<div class="standby-screen"><span>◌</span><h2>Lomba akan segera dimulai</h2><p>Silakan bersiap untuk babak berikutnya</p></div>`
          : `<div class="stage-question">${escapeHtml(question?.text || "Belum ada soal dipilih")}</div>${question ? `<div class="stage-points">${formatScore(question.value)} <span>poin</span></div>` : ""}`}
      </section>
      <section class="quiz-status">${alert}</section>
    </main>
  `, "quiz-shell");
}

function renderPlayer(state) {
  const selectedId = new URLSearchParams(window.location.search).get("team_id");
  const selectedTeam = state.teams.find((team) => team.id === selectedId);

  if (!selectedTeam) {
    app.innerHTML = sharedShell(`
      <main class="player-page player-select-page">
        <section class="player-card">
          <div class="player-emblem">LCC</div>
          <div class="section-kicker">AREA PESERTA</div>
          <h1>Masuk sebagai tim</h1>
          <p>Pilih tim Anda untuk membuka tombol buzzer.</p>
          ${state.teams.length ? `
            <form class="player-select-form" data-form="player-select">
              <label class="sr-only" for="player-team">Pilih tim</label>
              <select id="player-team" class="input-control" name="team_id" required>
                <option value="">Pilih tim...</option>
                ${state.teams.map((team) => `<option value="${team.id}">${escapeHtml(team.name)}</option>`).join("")}
              </select>
              <button class="button button-primary full-width" type="submit">Masuk ke buzzer <span aria-hidden="true">→</span></button>
            </form>
          ` : `<div class="empty-state compact-empty"><strong>Belum ada tim tersedia</strong><small>Minta admin menambahkan tim terlebih dahulu.</small></div>`}
          <a class="back-link" href="/">← Kembali ke beranda</a>
        </section>
      </main>
    `, "player-shell");
    return;
  }

  const hasBuzzed = state.buzzerTeamId === selectedTeam.id;
  const otherBuzzed = state.buzzerTeamId && !hasBuzzed;
  const buzzerTieTeamIds = state.buzzerTieTeamIds ?? [];
  const buzzerOpensAt = state.buzzerOpensAt;
  let buzzerContent;
  if (!state.rebuttalOpen) {
    buzzerContent = `<div class="player-message message-wait"><span>◷</span><strong>Menunggu babak rebutan</strong><p>Admin akan membuka buzzer sebentar lagi.</p></div>`;
  } else if (hasBuzzed) {
    buzzerContent = `<div class="player-message message-win"><span>✓</span><strong>Kamu yang tercepat!</strong><p>Tunggu arahan dari pembawa acara.</p></div>`;
  } else if (otherBuzzed) {
    buzzerContent = `<div class="player-message message-lost"><span>ϟ</span><strong>Tim lain lebih dulu</strong><p>Babak ini sudah dikunci.</p></div>`;
  } else if (buzzerTieTeamIds.length) {
    const teamWasTied = buzzerTieTeamIds.includes(selectedTeam.id);
    buzzerContent = `<div class="player-message message-wait"><span>ϟ</span><strong>${teamWasTied ? "Klaim bersamaan!" : "Babak berakhir seri"}</strong><p>${teamWasTied ? "Klaimmu masuk dalam jendela seri. Tunggu soal tie-break dari pembawa acara." : "Beberapa klaim tiba hampir bersamaan. Tunggu soal tie-break dari pembawa acara."}</p></div>`;
  } else if (!Number.isFinite(buzzerOpensAt)) {
    buzzerContent = `<div class="player-message message-wait"><span>◷</span><strong>Menyiapkan babak</strong><p>Menyinkronkan waktu mulai bersama...</p></div>`;
  } else if (getServerTime() < buzzerOpensAt) {
    buzzerContent = `<div class="player-message message-wait"><span>◷</span><strong>Siap-siap!</strong><p>Tombol buzzer akan aktif serentak.</p></div>`;
  } else {
    buzzerContent = `<button class="buzzer-button" type="button" data-action="buzz" data-team="${selectedTeam.id}"><span>BUZZ!</span><small>TEKAN SEKALI</small></button><p class="buzzer-help">Pastikan perangkat Anda sudah siap.</p>`;
  }

  app.innerHTML = sharedShell(`
    <main class="player-page">
      <section class="player-card player-active-card">
        <div class="player-topline"><span class="player-emblem small-emblem">LCC</span><a class="switch-team" href="/player">Ganti tim</a></div>
        <div class="section-kicker">PESERTA TERHUBUNG</div>
        <h1>${escapeHtml(selectedTeam.name)}</h1>
        <div class="player-score">${formatScore(selectedTeam.score)} <span>poin</span></div>
        <div class="player-buzzer-area">${buzzerContent}</div>
        <div class="player-sync"><i></i> Menunggu pembaruan langsung</div>
      </section>
    </main>
  `, "player-shell");
}

function render() {
  try {
    const state = readState();
    if (page === "admin") renderAdmin(state);
    else if (page === "quiz") renderQuiz(state);
    else if (page === "player") renderPlayer(state);
    else renderHome(state);
    scheduleBuzzerStart(state);
    renderBackendStatus(getBackendSyncStatus());
  } catch (error) {
    app.innerHTML = `
      <main class="fatal-error">
        <div class="section-kicker">PENYIMPANAN LOKAL</div>
        <h1>Data tidak dapat dimuat</h1>
        <p>${escapeHtml(error.message)}</p>
        <button class="button button-primary" type="button" data-action="recover-storage">Buat ulang data lokal</button>
      </main>
    `;
  }
}

function scheduleBuzzerStart(state) {
  clearTimeout(buzzerStartTimer);
  buzzerStartTimer = undefined;
  if (page !== "player" || !state.rebuttalOpen || state.buzzerTeamId
    || state.buzzerTieTeamIds?.length || !Number.isFinite(state.buzzerOpensAt)) {
    return;
  }
  const delay = state.buzzerOpensAt - getServerTime();
  if (delay > 0) {
    buzzerStartTimer = setTimeout(render, Math.min(delay + 1, 250));
  }
}

function playTone(frequency, duration = 0.15) {
  try {
    audioContext ??= new window.AudioContext();
    if (audioContext.state === "suspended") void audioContext.resume();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = frequency;
    oscillator.type = "sine";
    gain.gain.setValueAtTime(0.001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.13, audioContext.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + duration);
  } catch (error) {
    showToast(`Suara tidak dapat diputar: ${error.message}`, true);
  }
}

function playTeamSound(team) {
  if (!team?.soundData) {
    playTone(520, 0.18);
    return;
  }
  const audio = new Audio(team.soundData);
  audio.play().catch((error) => {
    showToast(`Suara tim tidak dapat diputar: ${error.message}`, true);
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(new Error("File suara gagal dibaca.")));
    reader.readAsDataURL(file);
  });
}

function normalizeHeader(value) {
  return String(value ?? "").toLowerCase().replace(/[\s_-]+/g, "");
}

function parseQuestionRows(rows) {
  if (!rows.length) return [];
  const aliases = {
    group: ["kelompok", "group", "kategori"],
    text: ["tekssoal", "soal", "pertanyaan", "question"],
    answer: ["jawaban", "answer", "kunci"],
    value: ["poin", "nilai", "value", "score"],
  };
  const first = rows[0].map(normalizeHeader);
  const hasHeader = first.some((cell) => Object.values(aliases).flat().includes(cell));
  const columns = hasHeader
    ? Object.fromEntries(Object.entries(aliases).map(([field, names]) => [
        field,
        first.findIndex((cell) => names.includes(cell)),
      ]))
    : { group: 0, text: 1, answer: 2, value: 3 };
  const dataRows = hasHeader ? rows.slice(1) : rows;
  return dataRows
    .filter((row) => row.some((cell) => String(cell ?? "").trim()))
    .map((row) => {
      const rawValue = columns.value >= 0 ? String(row[columns.value] ?? "").trim() : "";
      const parsedValue = Number(rawValue);
      return {
        id: newId("question"),
        group: columns.group >= 0 ? String(row[columns.group] ?? "").trim() : "",
        text: String(row[columns.text] ?? "").trim(),
        answer: columns.answer >= 0 ? String(row[columns.answer] ?? "").trim() : "",
        value: rawValue && Number.isFinite(parsedValue) ? Math.max(0, parsedValue) : 10,
      };
    })
    .filter((question) => question.text);
}

async function downloadQuestions(questions, fileName) {
  const XLSX = await import("@e965/xlsx");
  const rows = [
    ["Kelompok", "Teks Soal", "Jawaban", "Poin"],
    ...questions.map((question) => [question.group, question.text, question.answer, question.value]),
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Soal");
  XLSX.writeFile(workbook, fileName);
}

async function handleSubmit(event) {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  const formData = new FormData(form);

  try {
    if (form.dataset.form === "team") {
      const name = String(formData.get("name") ?? "").trim();
      const file = formData.get("sound");
      if (!name) throw new Error("Nama tim harus diisi.");
      if (file instanceof File && file.size > 2 * 1024 * 1024) {
        throw new Error("Ukuran file suara maksimal 2 MB.");
      }
      const soundData = file instanceof File && file.size ? await readFileAsDataUrl(file) : "";
      await updateState((state) => {
        state.teams.push({ id: newId("team"), name, score: 0, soundData });
      });
      showToast(`Tim ${name} berhasil ditambahkan.`);
    }

    if (form.dataset.form === "question") {
      const text = String(formData.get("text") ?? "").trim();
      if (!text) throw new Error("Teks soal harus diisi.");
      const value = Number(formData.get("value"));
      if (!Number.isFinite(value) || value < 0) throw new Error("Nilai poin harus berupa angka nol atau lebih.");
      activeTab = "questions";
      await updateState((state) => {
        state.questions.push({
          id: newId("question"),
          group: String(formData.get("group") ?? "").trim(),
          text,
          answer: String(formData.get("answer") ?? "").trim(),
          value,
        });
      });
      showToast("Soal berhasil ditambahkan.");
    }

    if (form.dataset.form === "player-select") {
      const teamId = String(formData.get("team_id") ?? "");
      if (!teamId) throw new Error("Pilih tim terlebih dahulu.");
      window.location.href = `/player?team_id=${encodeURIComponent(teamId)}`;
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

async function importQuestions(file) {
  if (!file) return;
  try {
    const XLSX = await import("@e965/xlsx");
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!firstSheet) throw new Error("File Excel tidak memiliki lembar kerja.");
    const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: "" });
    const questions = parseQuestionRows(rows);
    if (!questions.length) {
      throw new Error("Tidak ada soal yang terbaca. Pastikan kolom Teks Soal terisi.");
    }
    await updateState((state) => state.questions.push(...questions));
    showToast(`${questions.length} soal berhasil diimpor.`);
  } catch (error) {
    showToast(`Impor gagal: ${error.message}`, true);
  }
}

async function handleClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;

  if (action === "recover-storage") {
    if (!window.confirm("Data lokal yang rusak akan diganti dengan data contoh baru. Lanjutkan?")) return;
    try {
      localStorage.removeItem("lcc-local-state-v1");
      localStorage.removeItem("lcc-backend-cache-v1");
      render();
      showToast("Data lokal berhasil dibuat ulang.");
    } catch (error) {
      showToast(`Data tidak dapat dipulihkan: ${error.message}`, true);
    }
    return;
  }

  if (action === "export-questions" || action === "export-template") {
    try {
      const questions = action === "export-template" ? [] : readState().questions;
      await downloadQuestions(questions, action === "export-template" ? "template-soal-lcc.xlsx" : "bank-soal-lcc.xlsx");
      showToast(action === "export-template" ? "Template berhasil diunduh." : "Bank soal berhasil diunduh.");
    } catch (error) {
      showToast(`Ekspor gagal: ${error.message}`, true);
    }
    return;
  }

  if (action === "buzz") {
    const teamId = button.dataset.team;
    try {
      const accepted = await claimBuzzer(teamId);
      if (accepted) {
        const team = readState().teams.find((entry) => entry.id === teamId);
        playTeamSound(team);
      }
    } catch (error) {
      showToast(error.message, true);
    }
    return;
  }

  try {
    if (action === "score") {
      const teamId = button.dataset.team;
      const amount = Number(button.dataset.value);
      await updateState((state) => {
        const team = state.teams.find((entry) => entry.id === teamId);
        if (team) team.score = Math.max(0, (Number(team.score) || 0) + amount);
      });
      playTone(Number(button.dataset.value) > 0 ? 620 : 260, 0.14);
      return;
    }

    if (action === "delete-team") {
      if (!window.confirm("Hapus tim ini beserta suara buzzernya?")) return;
      const teamId = button.dataset.team;
      await updateState((state) => {
        state.teams = state.teams.filter((team) => team.id !== teamId);
        if (state.buzzerTeamId === teamId) state.buzzerTeamId = null;
        state.buzzerTieTeamIds = (state.buzzerTieTeamIds ?? []).filter((id) => id !== teamId);
      });
      showToast("Tim berhasil dihapus.");
      return;
    }

    if (action === "delete-question") {
      if (!window.confirm("Hapus soal ini dari bank soal?")) return;
      const questionId = button.dataset.question;
      await updateState((state) => {
        state.questions = state.questions.filter((question) => question.id !== questionId);
        if (state.currentQuestionId === questionId) {
          state.currentQuestionId = null;
          state.rebuttalOpen = false;
          state.buzzerTeamId = null;
          state.buzzerTieTeamIds = [];
        }
      });
      showToast("Soal berhasil dihapus.");
      return;
    }

    if (action === "set-question") {
      const questionId = button.dataset.question;
      await updateState((state) => {
        state.currentQuestionId = questionId;
        state.rebuttalOpen = false;
        state.buzzerTeamId = null;
        state.buzzerTieTeamIds = [];
        state.screen = "question";
      });
      playTone(760, 0.18);
      showToast("Soal aktif berhasil diperbarui.");
      return;
    }

    if (action === "toggle-rebuttal") {
      await updateState((state) => {
        state.rebuttalOpen = !state.rebuttalOpen;
        if (state.rebuttalOpen) {
          state.buzzerTeamId = null;
          state.buzzerTieTeamIds = [];
        }
      });
      showToast(readState().rebuttalOpen ? "Babak rebutan dibuka." : "Babak rebutan ditutup.");
      return;
    }

    if (action === "reset-buzzer") {
      await updateState((state) => {
        state.buzzerTeamId = null;
        state.buzzerTieTeamIds = [];
      });
      showToast("Buzzer berhasil direset.");
      return;
    }

    if (action === "toggle-screen") {
      await updateState((state) => {
        state.screen = state.screen === "standby" ? "question" : "standby";
      });
      showToast(readState().screen === "standby" ? "Layar masuk mode standby." : "Soal ditampilkan kembali.");
      return;
    }

    if (action === "reset-all") {
      if (!window.confirm("Reset semua tim, soal, skor, dan status kuis? Tindakan ini tidak dapat dibatalkan.")) return;
      await updateState((state) => Object.assign(state, createEmptyState()));
      showToast("Semua data kuis berhasil direset.");
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

app.addEventListener("submit", (event) => void handleSubmit(event));
app.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]");
  if (tab) {
    activeTab = tab.dataset.tab;
    render();
    return;
  }
  void handleClick(event);
});
app.addEventListener("change", (event) => {
  if (event.target.id === "question-group") {
    questionGroupFilter = event.target.value;
    render();
  }
  if (event.target.id === "import-file") {
    void importQuestions(event.target.files?.[0]);
  }
});

subscribeToStateChanges(render);
subscribeToBackendStatus(renderBackendStatus);
render();
