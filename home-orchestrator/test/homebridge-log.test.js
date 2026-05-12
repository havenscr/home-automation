// Smoke tests for the homebridge log parser used by /api/homekit/health.
// Focus on the actual log shapes we've seen in production -- DD/MM/YYYY
// timestamps, ANSI escapes, the "is on" vs "executed command" distinction,
// and the cutoff windowing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseHbTimestamp,
  stripAnsi,
  parseFireLine,
  extractDummyFires,
} = require('../lib/homebridge-log');

// ─── parseHbTimestamp ────────────────────────────────────────────────────────
test('parseHbTimestamp: valid DD/MM/YYYY format', () => {
  const ms = parseHbTimestamp('12/05/2026, 07:55:02');
  assert.ok(ms != null);
  const d = new Date(ms);
  // Date constructor uses local TZ; we just verify the components round-trip.
  assert.equal(d.getDate(), 12);
  assert.equal(d.getMonth(), 4); // May = month index 4
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getHours(), 7);
  assert.equal(d.getMinutes(), 55);
  assert.equal(d.getSeconds(), 2);
});

test('parseHbTimestamp: returns null on malformed input', () => {
  assert.equal(parseHbTimestamp(''), null);
  assert.equal(parseHbTimestamp('garbage'), null);
  assert.equal(parseHbTimestamp('2026-05-12 07:55:02'), null); // wrong format (ISO-ish)
  assert.equal(parseHbTimestamp('12/5/2026, 07:55:02'), null); // single-digit month
});

// ─── stripAnsi ──────────────────────────────────────────────────────────────
test('stripAnsi: removes color escapes', () => {
  const input = '\x1b[36m[Homebridge Dummy]\x1b[0m Dummy - Foo is on';
  assert.equal(stripAnsi(input), '[Homebridge Dummy] Dummy - Foo is on');
});

test('stripAnsi: passes plain text unchanged', () => {
  const input = '[12/05/2026, 07:55:02] [Homebridge Dummy] Foo is on';
  assert.equal(stripAnsi(input), input);
});

// ─── parseFireLine ──────────────────────────────────────────────────────────
test('parseFireLine: extracts "is on" toggle', () => {
  const line = '[12/05/2026, 07:55:02] [Homebridge Dummy] Dummy - Routine Start is on';
  const f = parseFireLine(line);
  assert.ok(f);
  assert.equal(f.name, 'Dummy - Routine Start');
  assert.equal(f.kind, 'toggle');
});

test('parseFireLine: extracts "executed command"', () => {
  const line = '[12/05/2026, 07:55:03] [Homebridge Dummy] Dummy - Fade Start Sunrise executed command: /usr/bin/curl -s -X POST http://localhost:5006/api/routines/sunrise_default/start';
  const f = parseFireLine(line);
  assert.ok(f);
  assert.equal(f.name, 'Dummy - Fade Start Sunrise');
  assert.equal(f.kind, 'command');
});

test('parseFireLine: handles ANSI color escapes in line', () => {
  const line = '\x1b[36m[12/05/2026, 07:55:02]\x1b[0m \x1b[32m[Homebridge Dummy]\x1b[0m Dummy - Foo is on';
  const f = parseFireLine(line);
  assert.ok(f);
  assert.equal(f.name, 'Dummy - Foo');
  assert.equal(f.kind, 'toggle');
});

test('parseFireLine: ignores non-matching lines', () => {
  // Non-Homebridge-Dummy lines should not produce false matches.
  assert.equal(parseFireLine('[12/05/2026, 07:55:02] [Hue] Light X turned on'), null);
  assert.equal(parseFireLine('random garbage'), null);
  assert.equal(parseFireLine(''), null);
});

test('parseFireLine: ignores lines with malformed timestamp', () => {
  // The timestamp parser returns null -> the whole line is rejected.
  const line = '[not a timestamp] [Homebridge Dummy] Dummy - Foo is on';
  assert.equal(parseFireLine(line), null);
});

test('parseFireLine: preserves whitespace-trimmed dummy name', () => {
  // Production logs sometimes have a trailing space (we saw one in the actual config).
  const line = '[12/05/2026, 07:55:02] [Homebridge Dummy] Dummy - Foo Bar  is on';
  const f = parseFireLine(line);
  assert.ok(f);
  // Note: the regex matches " is on" so the trailing space before "is" is consumed.
  // The captured name should not have trailing whitespace.
  assert.equal(f.name, 'Dummy - Foo Bar');
});

// ─── extractDummyFires (windowing) ──────────────────────────────────────────
test('extractDummyFires: filters by maxAgeMs from now', () => {
  // Build a log with three entries spanning a wide range.
  // Use a fixed "now" so the test is deterministic regardless of TZ/clock.
  const now = new Date(2026, 4, 12, 12, 0, 0).getTime(); // May 12 2026 12:00 local
  const oldEntry = '[10/05/2026, 12:00:00] [Homebridge Dummy] Old Dummy is on';
  const recentEntry = '[12/05/2026, 11:00:00] [Homebridge Dummy] Recent Dummy is on';
  const veryRecent = '[12/05/2026, 11:59:00] [Homebridge Dummy] Very Recent Dummy executed command: /foo';
  const text = [oldEntry, recentEntry, veryRecent].join('\n');

  // Window: last 2 hours. Should keep only the two recent entries.
  const twoHours = 2 * 60 * 60 * 1000;
  const fires = extractDummyFires(text, twoHours, now);
  assert.equal(fires.length, 2);
  assert.deepEqual(fires.map(f => f.name).sort(), ['Recent Dummy', 'Very Recent Dummy']);
});

test('extractDummyFires: empty input returns empty array', () => {
  assert.deepEqual(extractDummyFires('', 86400_000), []);
  assert.deepEqual(extractDummyFires(null, 86400_000), []);
});

test('extractDummyFires: mixes is-on and executed-command per dummy', () => {
  const now = new Date(2026, 4, 12, 12, 0, 0).getTime();
  const text = [
    '[12/05/2026, 07:55:02] [Homebridge Dummy] Dummy - Foo is on',
    '[12/05/2026, 07:55:03] [Homebridge Dummy] Dummy - Foo executed command: /bar',
    '[12/05/2026, 08:00:00] [Homebridge Dummy] Dummy - Other is on',
  ].join('\n');
  const fires = extractDummyFires(text, 24 * 60 * 60 * 1000, now);
  assert.equal(fires.length, 3);
  const fooFires = fires.filter(f => f.name === 'Dummy - Foo');
  assert.equal(fooFires.length, 2);
  assert.deepEqual(fooFires.map(f => f.kind).sort(), ['command', 'toggle']);
});

test('extractDummyFires: skips garbage lines without breaking', () => {
  const now = new Date(2026, 4, 12, 12, 0, 0).getTime();
  const text = [
    'unparseable garbage',
    '[12/05/2026, 11:00:00] [Homebridge Dummy] Dummy - OK is on',
    '',
    '[malformed timestamp] [Homebridge Dummy] Dummy - Skip is on',
    '[12/05/2026, 11:30:00] [Hue] Light X turned on',
  ].join('\n');
  const fires = extractDummyFires(text, 24 * 60 * 60 * 1000, now);
  assert.equal(fires.length, 1);
  assert.equal(fires[0].name, 'Dummy - OK');
});
