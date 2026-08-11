// lib/store.js
//
// Storage abstraction for the mock app.
//
// Vercel serverless functions do not share local disk/memory across
// invocations, so this app needs an external key-value store to behave
// like a real (mock) service instead of losing data on every request.
//
// - In production (Vercel), set UPSTASH_REDIS_REST_URL and
//   UPSTASH_REDIS_REST_TOKEN (free tier at upstash.com, or provision the
//   "Vercel KV" marketplace add-on, which is Upstash under the hood and
//   exposes the same env var names). All calls go over Upstash's REST API,
//   so no TCP client / connection pooling is needed in a serverless
//   function.
// - Locally, if those env vars are absent, everything falls back to a
//   JSON file at data/db.json so you can develop and run the Postman
//   collection without any external account.
//
// Every function here is intentionally tiny and JSON-in/JSON-out so the
// rest of the app never has to know which backend is active.

import { promises as fs } from "fs";
import path from "path";

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

const DB_FILE = path.join(process.cwd(), "data", "db.json");

// ---------------------------------------------------------------------
// Local JSON-file backend (dev only)
// ---------------------------------------------------------------------

let fileLock = Promise.resolve();

async function readDb() {
  try {
    const raw = await fs.readFile(DB_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { kv: {}, lists: {} };
  }
}

async function writeDb(db) {
  await fs.mkdir(path.dirname(DB_FILE), { recursive: true });
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

// Serialize file writes so concurrent requests in the same dev process
// don't clobber each other.
function withFileLock(fn) {
  const run = fileLock.then(fn, fn);
  fileLock = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------
// Upstash Redis REST backend (production)
// ---------------------------------------------------------------------

async function redisCmd(...args) {
  // POST the full Redis command in the request body. Besides avoiding URL
  // length issues for ordinary values, this is required now that the mock can
  // persist Base64-encoded Forms PDFs in Upstash.
  const res = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Upstash error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.result;
}

// ---------------------------------------------------------------------
// Public API: get / set / delete / list-push / list-range
// ---------------------------------------------------------------------

export async function kvGet(key) {
  if (USE_REDIS) {
    const val = await redisCmd("GET", key);
    return val ? JSON.parse(val) : null;
  }
  return withFileLock(async () => {
    const db = await readDb();
    return db.kv[key] ?? null;
  });
}

export async function kvSet(key, value) {
  if (USE_REDIS) {
    await redisCmd("SET", key, JSON.stringify(value));
    return;
  }
  return withFileLock(async () => {
    const db = await readDb();
    db.kv[key] = value;
    await writeDb(db);
  });
}

export async function kvDelete(key) {
  if (USE_REDIS) {
    await redisCmd("DEL", key);
    return;
  }
  return withFileLock(async () => {
    const db = await readDb();
    delete db.kv[key];
    await writeDb(db);
  });
}

// Returns true if the key did NOT already exist (i.e. this call is the
// one that created it) — used for idempotency guards.
export async function kvSetIfAbsent(key, value) {
  if (USE_REDIS) {
    const result = await redisCmd("SET", key, JSON.stringify(value), "NX");
    return result === "OK";
  }
  return withFileLock(async () => {
    const db = await readDb();
    if (db.kv[key] !== undefined) return false;
    db.kv[key] = value;
    await writeDb(db);
    return true;
  });
}

// Prepend to a list (newest first), capped at `cap` entries.
export async function listPush(listKey, value, cap = 500) {
  if (USE_REDIS) {
    await redisCmd("LPUSH", listKey, JSON.stringify(value));
    await redisCmd("LTRIM", listKey, "0", String(cap - 1));
    return;
  }
  return withFileLock(async () => {
    const db = await readDb();
    if (!db.lists[listKey]) db.lists[listKey] = [];
    db.lists[listKey].unshift(value);
    db.lists[listKey] = db.lists[listKey].slice(0, cap);
    await writeDb(db);
  });
}

export async function listRange(listKey, start = 0, end = 99) {
  if (USE_REDIS) {
    const items = await redisCmd("LRANGE", listKey, String(start), String(end));
    return (items || []).map((i) => JSON.parse(i));
  }
  return withFileLock(async () => {
    const db = await readDb();
    const list = db.lists[listKey] || [];
    return list.slice(start, end + 1);
  });
}

export const storageBackend = USE_REDIS ? "upstash-redis" : "local-json-file";
