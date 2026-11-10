import { isIP } from "node:net";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { RevisionConflictError, StateValidationError } from "./database.js";

const DEFAULT_BUZZER_CLAIM_WINDOW_MS = 150;
const DEFAULT_BUZZER_START_DELAY_MS = 2000;

function isPrivateIPv4(hostname) {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [first, second] = octets;
  return first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127);
}

function isLocalNetworkHost(hostname) {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(normalized) === 4) return isPrivateIPv4(normalized);
  if (isIP(normalized) !== 6) return false;
  if (normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  return /^fe[89ab]/.test(normalized);
}

function isLocalFrontendOrigin(origin, frontendPort) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:")
    && url.port === String(frontendPort)
    && url.origin === origin
    && isLocalNetworkHost(url.hostname);
}

export function createApp({
  store,
  allowedOrigins = [],
  frontendPort = 5173,
  buzzerStartDelayMs = DEFAULT_BUZZER_START_DELAY_MS,
  buzzerClaimWindowMs = DEFAULT_BUZZER_CLAIM_WINDOW_MS,
}) {
  if (!Number.isInteger(frontendPort) || frontendPort < 1 || frontendPort > 65535) {
    throw new Error("frontendPort harus berupa bilangan bulat antara 1 dan 65535.");
  }
  if (!Number.isSafeInteger(buzzerStartDelayMs) || buzzerStartDelayMs < 0 || buzzerStartDelayMs > 30_000) {
    throw new Error("buzzerStartDelayMs harus berupa bilangan bulat antara 0 dan 30000.");
  }
  if (!Number.isInteger(buzzerClaimWindowMs) || buzzerClaimWindowMs < 0 || buzzerClaimWindowMs > 1000) {
    throw new Error("buzzerClaimWindowMs harus berupa bilangan bulat antara 0 dan 1000.");
  }

  const app = new Hono();
  const originAllowed = (origin) => !origin
    || allowedOrigins.includes("*")
    || allowedOrigins.includes(origin)
    || isLocalFrontendOrigin(origin, frontendPort);
  const pendingBuzzerClaims = new Map();
  let buzzerClaimTimer;
  let buzzerClaimSequence = 0;

  function flushBuzzerClaims() {
    buzzerClaimTimer = undefined;
    const claims = [...pendingBuzzerClaims.values()]
      .sort((left, right) => left.receivedAt - right.receivedAt || left.sequence - right.sequence);
    pendingBuzzerClaims.clear();

    let winner;
    let snapshot;
    for (const claim of claims) {
      try {
        snapshot = store.claimBuzzer(claim.teamId);
      } catch (error) {
        if (error instanceof StateValidationError) {
          for (const request of claim.requests) request.reject(error);
          continue;
        }
        for (const pending of claims) {
          for (const request of pending.requests) request.reject(error);
        }
        return;
      }

      if (snapshot.accepted) {
        winner = claim;
        break;
      }
    }

    snapshot ??= store.read();
    for (const claim of claims) {
      for (const [index, request] of claim.requests.entries()) {
        request.resolve({
          ...snapshot,
          accepted: claim === winner && index === 0,
        });
      }
    }
  }

  function queueBuzzerClaim(teamId) {
    return new Promise((resolve, reject) => {
      let claim = pendingBuzzerClaims.get(teamId);
      if (!claim) {
        claim = {
          teamId,
          receivedAt: performance.now(),
          sequence: buzzerClaimSequence++,
          requests: [],
        };
        pendingBuzzerClaims.set(teamId, claim);
      }
      claim.requests.push({ resolve, reject });
      if (!buzzerClaimTimer) {
        buzzerClaimTimer = setTimeout(flushBuzzerClaims, buzzerClaimWindowMs);
      }
    });
  }

  app.use("/api/*", cors({
    origin: (origin) => originAllowed(origin) ? origin : null,
    allowMethods: ["GET", "PUT", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    exposeHeaders: ["X-Server-Time"],
    maxAge: 86400,
  }));
  app.use("/api/*", async (context, next) => {
    await next();
    context.header("X-Server-Time", String(Date.now()));
  });
  app.use("/api/state", bodyLimit({ maxSize: 5 * 1024 * 1024 }));
  app.use("/api/buzzer", bodyLimit({ maxSize: 16 * 1024 }));
  app.get("/health", (context) => context.json({ status: "ok" }));
  app.get("/api/state", (context) => {
    const snapshot = store.read();
    const sinceValue = context.req.query("since");
    if (sinceValue !== undefined) {
      if (!/^(0|[1-9]\d*)$/.test(sinceValue) || !Number.isSafeInteger(Number(sinceValue))) {
        return context.json({ error: "invalid_revision", message: "since harus berupa revision bilangan bulat nol atau lebih." }, 400);
      }
      if (snapshot.revision === Number(sinceValue)) {
        return context.body(null, 204, { "Cache-Control": "no-store" });
      }
    }
    return context.json(snapshot, 200, { "Cache-Control": "no-store" });
  });
  app.get("/api/teams", (context) => {
    const snapshot = store.read();
    return context.json({ revision: snapshot.revision, teams: snapshot.state.teams });
  });
  app.get("/api/questions", (context) => {
    const snapshot = store.read();
    return context.json({
      revision: snapshot.revision,
      questions: snapshot.state.questions,
      currentQuestionId: snapshot.state.currentQuestionId,
    });
  });

  app.put("/api/state", async (context) => {
    const body = await context.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return context.json({ error: "invalid_json", message: "Body harus berupa objek JSON." }, 400);
    }

    try {
      const snapshot = store.replace(body.state, body.expectedRevision, buzzerStartDelayMs);
      return context.json(snapshot);
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        return context.json({
          error: "revision_conflict",
          message: error.message,
          latest: error.latest,
        }, 409);
      }
      if (error instanceof StateValidationError) {
        return context.json({ error: "invalid_state", message: error.message, issues: error.issues }, 422);
      }
      throw error;
    }
  });

  app.post("/api/buzzer", async (context) => {
    const body = await context.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return context.json({ error: "invalid_json", message: "Body harus berupa objek JSON." }, 400);
    }
    try {
      const result = await queueBuzzerClaim(body.teamId);
      return context.json(result);
    } catch (error) {
      if (error instanceof StateValidationError) {
        return context.json({ error: "invalid_request", message: error.message, issues: error.issues }, 422);
      }
      throw error;
    }
  });

  app.onError((error, context) => {
    if (error instanceof HTTPException) {
      return context.json({ error: "request_rejected", message: error.message }, error.status);
    }
    console.error("[api] Unhandled request error:", error);
    return context.json({ error: "internal_error", message: "Terjadi kesalahan pada server." }, 500);
  });

  return app;
}
