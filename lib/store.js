// lib/store.js — Upstash REST in deployed environments, JSON file locally.
// v0.5 adds TTL, rate-limit counters, list compaction and namespace purge.

import { promises as fs } from "fs";
import path from "path";

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
const DB_FILE = path.join(process.cwd(), "data", "db.json");
let fileLock = Promise.resolve();

function normalizeDb(db) {
  return { kv: db?.kv || {}, lists: db?.lists || {}, expires: db?.expires || {} };
}

function purgeLocalExpired(db) {
  const now = Date.now();
  for (const [key, expiresAt] of Object.entries(db.expires || {})) {
    if (Number(expiresAt) <= now) {
      delete db.kv[key];
      delete db.lists[key];
      delete db.expires[key];
    }
  }
  return db;
}

async function readDb() {
  try {
    return purgeLocalExpired(normalizeDb(JSON.parse(await fs.readFile(DB_FILE, "utf8"))));
  } catch {
    return { kv: {}, lists: {}, expires: {} };
  }
}
async function writeDb(db) {
  await fs.mkdir(path.dirname(DB_FILE), { recursive: true });
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2));
}
function withFileLock(fn) {
  const run = fileLock.then(fn, fn);
  fileLock = run.catch(() => {});
  return run;
}

async function redisCmd(...args) {
  const res = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Upstash error ${res.status}: ${await res.text()}`);
  return (await res.json()).result;
}

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

export async function kvSet(key, value, options = {}) {
  const ttlSeconds = Number(options?.ttlSeconds || 0);
  if (USE_REDIS) {
    const args = ["SET", key, JSON.stringify(value)];
    if (ttlSeconds > 0) args.push("EX", String(Math.floor(ttlSeconds)));
    await redisCmd(...args);
    return;
  }
  return withFileLock(async () => {
    const db = await readDb();
    db.kv[key] = value;
    if (ttlSeconds > 0) db.expires[key] = Date.now() + ttlSeconds * 1000;
    else delete db.expires[key];
    await writeDb(db);
  });
}

export async function kvDelete(key) {
  if (USE_REDIS) { await redisCmd("DEL", key); return; }
  return withFileLock(async () => {
    const db = await readDb();
    delete db.kv[key]; delete db.lists[key]; delete db.expires[key];
    await writeDb(db);
  });
}

export async function kvSetIfAbsent(key, value, options = {}) {
  const ttlSeconds = Number(options?.ttlSeconds || 0);
  if (USE_REDIS) {
    const args = ["SET", key, JSON.stringify(value), "NX"];
    if (ttlSeconds > 0) args.push("EX", String(Math.floor(ttlSeconds)));
    return (await redisCmd(...args)) === "OK";
  }
  return withFileLock(async () => {
    const db = await readDb();
    if (db.kv[key] !== undefined) return false;
    db.kv[key] = value;
    if (ttlSeconds > 0) db.expires[key] = Date.now() + ttlSeconds * 1000;
    await writeDb(db);
    return true;
  });
}

export async function kvIncrementWithExpiry(key, ttlSeconds) {
  if (USE_REDIS) {
    const count = Number(await redisCmd("INCR", key));
    if (count === 1) await redisCmd("EXPIRE", key, String(Math.floor(ttlSeconds)));
    return count;
  }
  return withFileLock(async () => {
    const db = await readDb();
    const count = Number(db.kv[key] || 0) + 1;
    db.kv[key] = count;
    if (count === 1) db.expires[key] = Date.now() + ttlSeconds * 1000;
    await writeDb(db);
    return count;
  });
}

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
    return (db.lists[listKey] || []).slice(start, end + 1);
  });
}

export async function listReplace(listKey, values = []) {
  if (USE_REDIS) {
    await redisCmd("DEL", listKey);
    if (values.length) await redisCmd("RPUSH", listKey, ...values.map((v) => JSON.stringify(v)));
    return;
  }
  return withFileLock(async () => {
    const db = await readDb();
    db.lists[listKey] = [...values];
    await writeDb(db);
  });
}

export async function listRemoveValue(listKey, value) {
  if (USE_REDIS) { await redisCmd("LREM", listKey, "0", JSON.stringify(value)); return; }
  return withFileLock(async () => {
    const db = await readDb();
    db.lists[listKey] = (db.lists[listKey] || []).filter((v) => JSON.stringify(v) !== JSON.stringify(value));
    await writeDb(db);
  });
}

export async function deleteNamespace(prefix) {
  if (USE_REDIS) {
    let cursor = "0"; let deleted = 0;
    do {
      const result = await redisCmd("SCAN", cursor, "MATCH", `${prefix}*`, "COUNT", "200");
      cursor = String(result?.[0] ?? "0");
      const keys = result?.[1] || [];
      if (keys.length) { deleted += Number(await redisCmd("DEL", ...keys)) || keys.length; }
    } while (cursor !== "0");
    return deleted;
  }
  return withFileLock(async () => {
    const db = await readDb(); let deleted = 0;
    for (const collection of [db.kv, db.lists]) {
      for (const key of Object.keys(collection)) if (key.startsWith(prefix)) { delete collection[key]; delete db.expires[key]; deleted += 1; }
    }
    await writeDb(db);
    return deleted;
  });
}

export const storageBackend = USE_REDIS ? "upstash-redis" : "local-json-file";
export const persistentStorageConfigured = USE_REDIS;
