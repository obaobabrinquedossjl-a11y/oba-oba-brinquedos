type JsonRecord = Record<string, unknown>;

type StoredRecord = {
  collection: "toys" | "clients" | "quotes" | "settings";
  id: string;
  data: string;
  fingerprint: string;
};

type DatabaseRecord = {
  collection: StoredRecord["collection"];
  id: string;
  data: string;
  fingerprint: string;
};

const MAX_REQUEST_BYTES = 8_000_000;
const MAX_RECORD_BYTES = 1_900_000;
const MAX_MUTATIONS_PER_REQUEST = 45;
const encoder = new TextEncoder();

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function normalizeState(value: unknown): {
  toys: JsonRecord[];
  clients: JsonRecord[];
  quotes: JsonRecord[];
  settings: JsonRecord;
} {
  const input = isRecord(value) ? value : {};
  return {
    toys: safeArray(input.toys),
    clients: safeArray(input.clients),
    quotes: safeArray(input.quotes),
    settings: isRecord(input.settings) ? input.settings : {},
  };
}

function restoreState(rows: DatabaseRecord[]): {
  toys: JsonRecord[];
  clients: JsonRecord[];
  quotes: JsonRecord[];
  settings: JsonRecord;
} | null {
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

async function fingerprint(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(data));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
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
    if (encoder.encode(data).byteLength > MAX_RECORD_BYTES) {
      throw new RangeError(`O registro ${candidate.collection}/${candidate.id} excede o limite permitido.`);
    }
    return { collection: candidate.collection, id: candidate.id, data, fingerprint: await fingerprint(data) };
  }));
}

async function getState(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    "SELECT collection, id, data, fingerprint FROM app_records ORDER BY collection, updated_at, id",
  ).all<DatabaseRecord>();
  return json({ state: restoreState(result.results), updatedAt: new Date().toISOString() });
}

async function putState(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "Origem não permitida." }, 403);
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Envie os dados como application/json." }, 415);
  }

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
      `INSERT INTO app_records (collection, id, data, fingerprint, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (collection, id) DO UPDATE SET
         data = excluded.data,
         fingerprint = excluded.fingerprint,
         updated_at = excluded.updated_at`,
    ).bind(record.collection, record.id, record.data, record.fingerprint, new Date().toISOString()));
  }

  for (const row of existingResult.results) {
    if (!desiredKeys.has(`${row.collection}:${row.id}`)) {
      statements.push(env.DB.prepare("DELETE FROM app_records WHERE collection = ? AND id = ?").bind(row.collection, row.id));
    }
  }

  if (statements.length > MAX_MUTATIONS_PER_REQUEST) {
    return json({ error: "Muitas alterações simultâneas. Recarregue a página e tente novamente." }, 409);
  }
  if (statements.length > 0) await env.DB.batch(statements);

  return json({ ok: true, changed: statements.length, updatedAt: new Date().toISOString() });
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/health" && request.method === "GET") {
    await env.DB.prepare("SELECT 1").first();
    return json({ ok: true, database: "connected" });
  }
  if (url.pathname === "/api/state" && request.method === "GET") return getState(env);
  if (url.pathname === "/api/state" && request.method === "PUT") return putState(request, env);
  if (url.pathname === "/api/state") return json({ error: "Método não permitido." }, 405);
  return json({ error: "Rota não encontrada." }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
} satisfies ExportedHandler<Env>;
