'use strict';

// Daily per-user quota, persisted to a JSON file next to this module.
//
// checkQuota (read-only) and recordQuery (write) are deliberately separate
// with a small, swappable shape so this file can later be backed by a
// Supabase table without touching any other code.
//
// Every user gets the same limit. There is intentionally no country, IP,
// or region logic here — do not add any.

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'quota-data.json');

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function dailyLimit() {
  const n = parseInt(process.env.DAILY_FREE_QUERY_LIMIT || '50', 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

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

function usageFor(data, userId) {
  const day = data[todayKey()];
  return day && typeof day[userId] === 'number' ? day[userId] : 0;
}

async function checkQuota(userId) {
  const limit = dailyLimit();
  const used = usageFor(load(), userId);
  return { allowed: used < limit, used, remaining: Math.max(0, limit - used), limit };
}

async function recordQuery(userId) {
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

module.exports = { checkQuota, recordQuery };
