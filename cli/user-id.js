'use strict';

// Anonymous per-machine identity. A random ID is generated once and stored
// at ~/.sovereign-ai/id; every later run reuses it. It is not tied to a
// name, email, or any personal information — it only exists so the server
// can apply the daily free-query limit per installation.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(os.homedir(), '.sovereign-ai');
const ID_FILE = path.join(DIR, 'id');

function getUserId() {
  try {
    const existing = fs.readFileSync(ID_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // first run — fall through and create one
  }
  const id = crypto.randomUUID();
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(ID_FILE, id + '\n', { mode: 0o600 });
  return id;
}

module.exports = { getUserId };
