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

export function validateState(state) {
  const issues = [];
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return ["State harus berupa objek."];
  }
  if (state.version !== 1) issues.push("Versi state harus 1.");
  if (!Array.isArray(state.teams) || state.teams.length > 100) {
    issues.push("teams harus berupa array dengan maksimal 100 tim.");
  }
  if (!Array.isArray(state.questions) || state.questions.length > 5000) {
    issues.push("questions harus berupa array dengan maksimal 5000 soal.");
  }
  if (typeof state.rebuttalOpen !== "boolean") {
    issues.push("rebuttalOpen harus berupa boolean.");
  }
  if (state.screen !== "question" && state.screen !== "standby") {
    issues.push("screen harus bernilai question atau standby.");
  }
  if (state.currentQuestionId !== null && typeof state.currentQuestionId !== "string") {
    issues.push("currentQuestionId harus berupa string atau null.");
  }
  if (state.buzzerTeamId !== null && typeof state.buzzerTeamId !== "string") {
    issues.push("buzzerTeamId harus berupa string atau null.");
  }
  if (state.updatedAt !== undefined && !Number.isFinite(state.updatedAt)) {
    issues.push("updatedAt harus berupa angka.");
  }
  if (issues.length) return issues;

  const teamIds = new Set();
  for (const [index, team] of state.teams.entries()) {
    if (!team || typeof team !== "object" || Array.isArray(team)) {
      issues.push(`teams[${index}] harus berupa objek.`);
      continue;
    }
    if (!isText(team.id, 128) || teamIds.has(team.id)) {
      issues.push(`teams[${index}].id harus unik dan tidak kosong.`);
    }
    teamIds.add(team.id);
    if (!isText(team.name, 100)) issues.push(`teams[${index}].name wajib diisi (maksimal 100 karakter).`);
    if (!Number.isFinite(team.score) || team.score < 0) {
      issues.push(`teams[${index}].score harus berupa angka nol atau lebih.`);
    }
    if (typeof team.soundData !== "string" || team.soundData.length > 3_000_000) {
      issues.push(`teams[${index}].soundData harus berupa string maksimal 3 MB.`);
    }
  }

  const questionIds = new Set();
  for (const [index, question] of state.questions.entries()) {
    if (!question || typeof question !== "object" || Array.isArray(question)) {
      issues.push(`questions[${index}] harus berupa objek.`);
      continue;
    }
    if (!isText(question.id, 128) || questionIds.has(question.id)) {
      issues.push(`questions[${index}].id harus unik dan tidak kosong.`);
    }
    questionIds.add(question.id);
    if (typeof question.group !== "string" || question.group.length > 120) {
      issues.push(`questions[${index}].group harus berupa teks maksimal 120 karakter.`);
    }
    if (!isText(question.text, 4000)) {
      issues.push(`questions[${index}].text wajib diisi (maksimal 4000 karakter).`);
    }
    if (typeof question.answer !== "string" || question.answer.length > 1000) {
      issues.push(`questions[${index}].answer harus berupa teks maksimal 1000 karakter.`);
    }
    if (!Number.isFinite(question.value) || question.value < 0) {
      issues.push(`questions[${index}].value harus berupa angka nol atau lebih.`);
    }
  }

  if (state.currentQuestionId !== null && !questionIds.has(state.currentQuestionId)) {
    issues.push("currentQuestionId harus menunjuk ke soal yang tersedia.");
  }
  if (state.buzzerTeamId !== null && !teamIds.has(state.buzzerTeamId)) {
    issues.push("buzzerTeamId harus menunjuk ke tim yang tersedia.");
  }
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > 5 * 1024 * 1024) {
    issues.push("Ukuran total state melebihi 5 MB.");
  }
  return issues;
}

function isText(value, maxLength) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}
