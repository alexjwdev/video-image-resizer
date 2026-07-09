'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// In-memory id -> {path, name, mime, createdAt}. Deliberately not persisted:
// a server restart between "compress" and "download click" loses the file,
// which is an acceptable tradeoff for an internal tool.
const registry = new Map();

const DIR = path.join(os.tmpdir(), 'image-resizer-downloads');
fs.mkdirSync(DIR, { recursive: true });

// Persists a buffer to a registry-owned scratch file and returns a download id.
function putBuffer(buffer, { name, mime, ext = '' }) {
  const id = crypto.randomUUID();
  const filePath = path.join(DIR, id + ext);
  fs.writeFileSync(filePath, buffer);
  registry.set(id, { path: filePath, name, mime, createdAt: Date.now() });
  return id;
}

function get(id) {
  return registry.get(id);
}

function remove(id) {
  const entry = registry.get(id);
  if (!entry) return;
  registry.delete(id);
  fs.unlink(entry.path, () => {}); // best-effort; ignore ENOENT etc.
}

function sweep(maxAgeMs) {
  const now = Date.now();
  for (const [id, entry] of registry) {
    if (now - entry.createdAt > maxAgeMs) remove(id);
  }
}

module.exports = { putBuffer, get, remove, sweep };
