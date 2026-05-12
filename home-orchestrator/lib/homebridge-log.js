// Parser utilities for homebridge.log. Extracted from server.js so they can
// be unit-tested without touching the filesystem. Two key surfaces:
//   - parseHbTimestamp(str) -> epoch ms or null
//   - extractDummyFires(text, maxAgeMs, now) -> [{ts, name, kind}]
// File I/O remains in server.js; this module is pure functions.

const fs = require('fs');

// "12/05/2026, 07:55:02" -> epoch ms in Pi local time (America/Los_Angeles).
// Returns null on parse failure so callers can skip malformed lines.
function parseHbTimestamp(s) {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4}),\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  // Date(year, monthIdx, day, hr, min, sec) interprets as local time, which
  // is what we want -- Pi is set to PT and homebridge logs in local.
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]),
                   Number(m[4]), Number(m[5]), Number(m[6])).getTime();
}

// Strip ANSI color escapes that homebridge sometimes emits when running under TTY.
function stripAnsi(line) {
  return line.replace(/\x1b\[[0-9;]*m/g, '');
}

// Match a dummy fire line. Returns null if not a match.
// Two kinds matter: "is on" (HomeKit-side toggle) and "executed command"
// (commandOn fired -- meaning the dummy triggered an actual HTTP call).
const FIRE_RE = /^\[([^\]]+)\]\s+\[Homebridge Dummy\]\s+(.+?)\s+(is on|executed command)/;
function parseFireLine(lineRaw) {
  const line = stripAnsi(lineRaw);
  const m = line.match(FIRE_RE);
  if (!m) return null;
  const ts = parseHbTimestamp(m[1]);
  if (ts == null) return null;
  return {
    ts,
    name: m[2].trim(),
    kind: m[3] === 'is on' ? 'toggle' : 'command',
  };
}

// Extract dummy fires from a homebridge.log text body, filtered to entries
// within maxAgeMs of `now`. Pure function -- pass the file contents directly.
// Used by server.js after fs.readFileSync.
function extractDummyFires(text, maxAgeMs, now = Date.now()) {
  if (!text) return [];
  const cutoff = now - maxAgeMs;
  const fires = [];
  for (const line of text.split('\n')) {
    const f = parseFireLine(line);
    if (f && f.ts >= cutoff) fires.push(f);
  }
  return fires;
}

// Convenience wrapper: read a homebridge log file and extract fires from it.
// Tail to last `maxLines` to bound memory on large logs.
function readDummyFiresFromFile(path, maxAgeMs, opts = {}) {
  const { maxLines = 200000, now = Date.now() } = opts;
  let raw;
  try { raw = fs.readFileSync(path, 'utf8'); } catch { return []; }
  // Slice from the tail when the log is huge.
  const allLines = raw.split('\n');
  const tail = allLines.length > maxLines ? allLines.slice(-maxLines).join('\n') : raw;
  return extractDummyFires(tail, maxAgeMs, now);
}

module.exports = {
  parseHbTimestamp,
  stripAnsi,
  parseFireLine,
  extractDummyFires,
  readDummyFiresFromFile,
};
