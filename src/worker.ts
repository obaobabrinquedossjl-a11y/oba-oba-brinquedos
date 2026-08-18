type JsonRecord = Record<string, unknown>;
type AppEnv = Env & { ADMIN_PASSWORD: string; SESSION_SECRET: string };
type StoredRecord = { collection: "toys" | "clients" | "quotes" | "settings"; id: string; data: string; fingerprint: string };
type DatabaseRecord = StoredRecord;
type LoginAttempt = { attempts: number; window_started: number; blocked_until: number };

const MAX_REQUEST_BYTES = 8_000_000;
const MAX_RECORD_BYTES = 1_900_000;
const MAX_MUTATIONS_PER_REQUEST = 45;
const SESSION_COOKIE = "oba_session";
const SESSION_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_SECONDS = 10 * 60;
const LOGIN_BLOCK_SECONDS = 15 * 60;
const MAX_LOGIN_ATTEMPTS = 5;
const encoder = new TextEncoder();

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers } });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function normalizeState(value: unknown) {
  const input = isRecord(value) ? value : {};
  return {
    toys: safeArray(input.toys),
    clients: safeArray(input.clients),
    quotes: safeArray(input.quotes),
    settings: isRecord(input.settings) ? input.settings : {},
  };
}

function restoreState(rows: DatabaseRecord[]): ReturnType<typeof normalizeState> | null {
  if (rows.length === 0) return null;
  const state = { toys: [] as JsonRecord[], clients: [] as JsonRecord[], quotes: [] as JsonRecord[], settings: {} as JsonRecord };
  for (const row of rows) {
    try {
      const value: unknown = JSON.parse(row.data);
      if (!isRecord(value)) continue;
      if (row.collection === "settings") state.settings = value;
      else state[row.collection].push(value);
    } catch {
      console.error(JSON.stringify({ message: "invalid database record", collection: row.collection, id: row.id }));
    }
  }
  return state;
}

function idForRecord(item: JsonRecord, index: number): string {
  return typeof item.id === "string" && item.id ? item.id : `legacy-${index}`;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function fingerprint(data: string): Promise<string> {
  return Array.from(await sha256(data), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)]);
  let difference = 0;
  for (let index = 0; index < leftHash.length; index += 1) difference |= leftHash[index] ^ rightHash[index];
  return difference === 0;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

async function sessionKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function createSession(username: string, secret: string): Promise<string> {
  const payload = base64Url(encoder.encode(JSON.stringify({ username, expiresAt: Math.floor(Date.now() / 1000) + SESSION_SECONDS })));
  const signature = await crypto.subtle.sign("HMAC", await sessionKey(secret), encoder.encode(payload));
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

async function verifySession(token: string | null, env: AppEnv): Promise<boolean> {
  if (!token) return false;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return false;
  try {
    const signatureBytes = decodeBase64Url(signature);
    const valid = await crypto.subtle.verify("HMAC", await sessionKey(env.SESSION_SECRET), signatureBytes.buffer as ArrayBuffer, encoder.encode(payload));
    if (!valid) return false;
    const session: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
    return isRecord(session) && session.username === env.ADMIN_USERNAME && typeof session.expiresAt === "number" && session.expiresAt > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function validOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

async function clientKey(request: Request): Promise<string> {
  return base64Url(await sha256(request.headers.get("CF-Connecting-IP") || "local"));
}

async function login(request: Request, env: AppEnv): Promise<Response> {
  if (!validOrigin(request)) return json({ error: "Origem não permitida." }, 403);
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return json({ error: "Envie os dados como application/json." }, 415);

  const key = await clientKey(request);
  const now = Math.floor(Date.now() / 1000);
  const previous = await env.DB.prepare("SELECT attempts, window_started, blocked_until FROM login_attempts WHERE key = ?").bind(key).first<LoginAttempt>();
  if (previous && previous.blocked_until > now) {
    return json({ error: "Muitas tentativas. Aguarde 15 minutos e tente novamente." }, 429, { "Retry-After": String(previous.blocked_until - now) });
  }

  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "Dados de login inválidos." }, 400); }
  const username = isRecord(body) && typeof body.username === "string" ? body.username : "";
  const password = isRecord(body) && typeof body.password === "string" ? body.password : "";
  const [usernameMatches, passwordMatches] = await Promise.all([
    constantTimeEqual(username, env.ADMIN_USERNAME),
    constantTimeEqual(password, env.ADMIN_PASSWORD),
  ]);

  if (!usernameMatches || !passwordMatches) {
    const withinWindow = Boolean(previous && now - previous.window_started < LOGIN_WINDOW_SECONDS);
    const attempts = withinWindow ? previous!.attempts + 1 : 1;
    const blockedUntil = attempts >= MAX_LOGIN_ATTEMPTS ? now + LOGIN_BLOCK_SECONDS : 0;
    await env.DB.prepare(
      `INSERT INTO login_attempts (key, attempts, window_started, blocked_until) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET attempts = excluded.attempts, window_started = excluded.window_started, blocked_until = excluded.blocked_until`,
    ).bind(key, attempts, withinWindow ? previous!.window_started : now, blockedUntil).run();
    return json({ error: blockedUntil ? "Muitas tentativas. Aguarde 15 minutos e tente novamente." : "Usuário ou senha incorretos." }, blockedUntil ? 429 : 401);
  }

  await env.DB.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run();
  const token = await createSession(env.ADMIN_USERNAME, env.SESSION_SECRET);
  console.log(JSON.stringify({ message: "admin login succeeded" }));
  return json({ ok: true, username: env.ADMIN_USERNAME }, 200, { "Set-Cookie": sessionCookie(token) });
}

async function recordsFromState(value: unknown): Promise<StoredRecord[]> {
  const state = normalizeState(value);
  const candidates: Array<{ collection: StoredRecord["collection"]; id: string; value: JsonRecord }> = [];
  for (const collection of ["toys", "clients", "quotes"] as const) {
    state[collection].forEach((item, index) => candidates.push({ collection, id: idForRecord(item, index), value: item }));
  }
  candidates.push({ collection: "settings", id: "company", value: state.settings });
  return Promise.all(candidates.map(async candidate => {
    const data = JSON.stringify(candidate.value);
    if (encoder.encode(data).byteLength > MAX_RECORD_BYTES) throw new RangeError(`O registro ${candidate.collection}/${candidate.id} excede o limite permitido.`);
    return { collection: candidate.collection, id: candidate.id, data, fingerprint: await fingerprint(data) };
  }));
}

async function getState(env: AppEnv): Promise<Response> {
  const result = await env.DB.prepare("SELECT collection, id, data, fingerprint FROM app_records ORDER BY collection, updated_at, id").all<DatabaseRecord>();
  return json({ state: restoreState(result.results), updatedAt: new Date().toISOString() });
}

async function putState(request: Request, env: AppEnv): Promise<Response> {
  if (!validOrigin(request)) return json({ error: "Origem não permitida." }, 403);
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return json({ error: "Envie os dados como application/json." }, 415);
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_REQUEST_BYTES) return json({ error: "O conjunto de dados excede o limite desta versão." }, 413);

  const body: unknown = await request.json();
  const desired = await recordsFromState(isRecord(body) && "state" in body ? body.state : body);
  const existingResult = await env.DB.prepare("SELECT collection, id, fingerprint FROM app_records").all<DatabaseRecord>();
  const existing = new Map(existingResult.results.map(row => [`${row.collection}:${row.id}`, row]));
  const desiredKeys = new Set(desired.map(row => `${row.collection}:${row.id}`));
  const statements: D1PreparedStatement[] = [];

  for (const record of desired) {
    const key = `${record.collection}:${record.id}`;
    if (existing.get(key)?.fingerprint === record.fingerprint) continue;
    statements.push(env.DB.prepare(
      `INSERT INTO app_records (collection, id, data, fingerprint, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`,
    ).bind(record.collection, record.id, record.data, record.fingerprint, new Date().toISOString()));
  }
  for (const row of existingResult.results) {
    if (!desiredKeys.has(`${row.collection}:${row.id}`)) statements.push(env.DB.prepare("DELETE FROM app_records WHERE collection = ? AND id = ?").bind(row.collection, row.id));
  }
  if (statements.length > MAX_MUTATIONS_PER_REQUEST) return json({ error: "Muitas alterações simultâneas. Recarregue a página e tente novamente." }, 409);
  if (statements.length > 0) await env.DB.batch(statements);
  return json({ ok: true, changed: statements.length, updatedAt: new Date().toISOString() });
}

async function handleApi(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/health" && request.method === "GET") {
    await env.DB.prepare("SELECT 1").first();
    return json({ ok: true, database: "connected" });
  }
  if (url.pathname === "/api/auth/login" && request.method === "POST") return login(request, env);
  if (url.pathname === "/api/auth/session" && request.method === "GET") return json({ authenticated: await verifySession(cookieValue(request, SESSION_COOKIE), env) });
  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    if (!validOrigin(request)) return json({ error: "Origem não permitida." }, 403);
    return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
  }

  if (!await verifySession(cookieValue(request, SESSION_COOKIE), env)) return json({ error: "Faça login para continuar." }, 401);
  if (url.pathname === "/api/state" && request.method === "GET") return getState(env);
  if (url.pathname === "/api/state" && request.method === "PUT") return putState(request, env);
  if (url.pathname === "/api/state") return json({ error: "Método não permitido." }, 405);
  return json({ error: "Rota não encontrada." }, 404);
}

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env);
      return await env.ASSETS.fetch(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ message: "request failed", error: message, path: new URL(request.url).pathname }));
      if (error instanceof RangeError) return json({ error: message }, 413);
      return json({ error: "Não foi possível concluir a operação." }, 500);
    }
  },
} satisfies ExportedHandler<AppEnv>;
