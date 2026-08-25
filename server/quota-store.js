'use strict';

// Daily per-user quota.
//
// Storage backends, selected automatically:
//  - Supabase (PostgREST) when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set.
//    Persists across Render redeploys/restarts — required for real users.
//  - JSON file fallback (quota-data.json) for local dev with no Supabase config.
//
// checkQuota (read-only) and recordQuery (write) keep a small, swappable
// shape so nothing outside this file cares which backend is active.
//
// Every user gets the same limit. There is intentionally no country, IP,
// or region logic here — do not add any.

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'quota-data.json');

const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const useSupabase = !!(SUPA_URL && SUPA_KEY);

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function dailyLimit() {
  const n = parseInt(process.env.DAILY_FREE_QUERY_LIMIT || '50', 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

// ---------- JSON file backend ----------

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(data) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

async function fileCheck(userId) {
  const limit = dailyLimit();
  const day = load()[todayKey()];
  const used = day && typeof day[userId] === 'number' ? day[userId] : 0;
  return { allowed: used < limit, used, remaining: Math.max(0, limit - used), limit };
}

async function fileRecord(userId) {
  const limit = dailyLimit();
  const data = load();
  const day = todayKey();
  if (!data[day]) data[day] = {};
  data[day][userId] = (typeof data[day][userId] === 'number' ? data[day][userId] : 0) + 1;
  // Drop previous days so the file doesn't grow forever.
  for (const key of Object.keys(data)) {
    if (key !== day) delete data[key];
  }
  save(data);
  const used = data[day][userId];
  return { used, remaining: Math.max(0, limit - used), limit };
}

// ---------- Supabase backend ----------

function supaHeaders(extra = {}) {
  return {
    apikey: SUPA_KEY,
    Authorization: `Bearer ${SUPA_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function supaGetCount(userId) {
  const res = await fetch(
    `${SUPA_URL}/rest/v1/quota_usage?user_id=eq.${encodeURIComponent(userId)}&day=eq.${todayKey()}&select=count`,
    { headers: supaHeaders() }
  );
  if (!res.ok) throw new Error(`supabase read failed: HTTP ${res.status}`);
  const rows = await res.json();
  return rows.length > 0 ? rows[0].count : 0;
}

async function supaCheck(userId) {
  const limit = dailyLimit();
  const used = await supaGetCount(userId);
  return { allowed: used < limit, used, remaining: Math.max(0, limit - used), limit };
}

async function supaRecord(userId) {
  const limit = dailyLimit();
  const res = await fetch(`${SUPA_URL}/rest/v1/quota_usage`, {
    method: 'POST',
    headers: supaHeaders({
      Prefer: 'resolution=merge-duplicates,return=representation',
    }),
    body: JSON.stringify({ user_id: userId, day: todayKey(), count: (await supaGetCount(userId)) + 1 }),
  });
  if (!res.ok) throw new Error(`supabase write failed: HTTP ${res.status}`);
  const rows = await res.json();
  const used = rows[0].count;
  return { used, remaining: Math.max(0, limit - used), limit };
}

// ---------- public API ----------

async function checkQuota(userId) {
  return useSupabase ? supaCheck(userId) : fileCheck(userId);
}

async function recordQuery(userId) {
  return useSupabase ? supaRecord(userId) : fileRecord(userId);
}

module.exports = { checkQuota, recordQuery };
