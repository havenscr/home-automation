// Smoke tests for climate.js: ladder validator, pressureToRungCount hysteresis,
// and unit conversions. Built on the Node built-in test runner (no Jest needed
// on the Pi). Run with: npm test
//
// Scope: catch the bug shapes we've actually hit in production:
//   - char-spread "not an object" corruption in ladder
//   - office-HIGH-in-officeQuiet drift
//   - off-by-one in pressureToRungCount hysteresis
//   - C<->F conversion drift
// Not a full coverage push -- just the high-value spots.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClimate, cToF, fToC, WIND_MAP } = require('../climate.js');

// Minimal getConfig stub. Tests inject ladder shapes via this.
function makeStub(climateConfig) {
  const cfg = { climate: climateConfig };
  return {
    getConfig: () => cfg,
    logActivity: () => {}, // swallow
  };
}

// ─── Unit conversions ────────────────────────────────────────────────────────
test('cToF: zero handling', () => {
  assert.equal(cToF(0), 32);
  assert.equal(cToF(100), 212);
  assert.equal(cToF(null), null);
});

test('fToC: round-trip is lossy but stable', () => {
  // 74F -> 23.3C -> 73.9F is fine; just make sure we don't drift more than 0.1F over a cycle
  const original = 74;
  const c = fToC(original);
  const backF = cToF(c);
  assert.ok(Math.abs(backF - original) < 0.2, `roundtrip drift too high: ${original}F -> ${c}C -> ${backF}F`);
});

test('WIND_MAP: handles all known synonyms', () => {
  assert.equal(WIND_MAP.low, 'LOW');
  assert.equal(WIND_MAP.mid, 'MID');
  assert.equal(WIND_MAP.medium, 'MID');
  assert.equal(WIND_MAP.high, 'HIGH');
});

// ─── Ladder validator ────────────────────────────────────────────────────────
test('validateLadder: well-formed ladder produces no warnings', () => {
  const c = createClimate(makeStub({
    devices: { office: { deviceId: 'x' }, kitchen: { deviceId: 'y' } },
    ladder: {
      default: [['kitchen', 'low'], ['office', 'medium'], ['office', 'high']],
      officeQuiet: [['kitchen', 'low'], ['kitchen', 'medium'], ['kitchen', 'high'], ['office', 'medium']],
    },
  }));
  assert.deepEqual(c.validateLadder(), []);
});

test('validateLadder: catches char-spread "not an object" corruption', () => {
  // This is the actual shape we cleaned out of config.json on 2026-05-12
  const corrupt = {};
  'not an object'.split('').forEach((ch, i) => { corrupt[i] = ch; });
  corrupt.default = [['kitchen', 'low']];
  corrupt.officeQuiet = [['kitchen', 'low']];
  const c = createClimate(makeStub({
    devices: { kitchen: { deviceId: 'y' } },
    ladder: corrupt,
  }));
  const warnings = c.validateLadder();
  const junkWarning = warnings.find(w => w.includes('numeric junk keys'));
  assert.ok(junkWarning, 'expected a numeric-junk-keys warning, got: ' + JSON.stringify(warnings));
});

test('validateLadder: warns when officeQuiet allows office HIGH', () => {
  const c = createClimate(makeStub({
    devices: { office: { deviceId: 'x' }, kitchen: { deviceId: 'y' } },
    ladder: {
      default: [['kitchen', 'low']],
      officeQuiet: [['kitchen', 'low'], ['office', 'medium'], ['office', 'high']],
    },
  }));
  const warnings = c.validateLadder();
  const drift = warnings.find(w => w.includes('officeQuiet') && w.includes('office'));
  assert.ok(drift, 'expected office-high drift warning, got: ' + JSON.stringify(warnings));
});

test('validateLadder: catches non-object ladder', () => {
  const c = createClimate(makeStub({
    devices: { kitchen: { deviceId: 'y' } },
    ladder: 'not an object',
  }));
  const warnings = c.validateLadder();
  assert.ok(warnings.some(w => w.includes('must be a plain object')));
});

test('validateLadder: catches array ladder', () => {
  const c = createClimate(makeStub({
    devices: { kitchen: { deviceId: 'y' } },
    ladder: [['kitchen', 'low']],
  }));
  const warnings = c.validateLadder();
  assert.ok(warnings.some(w => w.includes('must be a plain object')));
});

test('validateLadder: catches malformed rung tuples', () => {
  const c = createClimate(makeStub({
    devices: { kitchen: { deviceId: 'y' } },
    ladder: {
      default: [['kitchen']],  // missing speed
      officeQuiet: [['kitchen', 'low']],
    },
  }));
  const warnings = c.validateLadder();
  assert.ok(warnings.some(w => w.includes('default[0]') && w.includes('2-element')));
});

test('validateLadder: catches unknown room references', () => {
  const c = createClimate(makeStub({
    devices: { office: { deviceId: 'x' }, kitchen: { deviceId: 'y' } },
    ladder: {
      default: [['bathroom', 'low']],
      officeQuiet: [['kitchen', 'low']],
    },
  }));
  const warnings = c.validateLadder();
  assert.ok(warnings.some(w => w.includes('unknown room') && w.includes('bathroom')));
});

test('validateLadder: catches invalid speed values', () => {
  const c = createClimate(makeStub({
    devices: { kitchen: { deviceId: 'y' } },
    ladder: {
      default: [['kitchen', 'turbo']],
      officeQuiet: [['kitchen', 'low']],
    },
  }));
  const warnings = c.validateLadder();
  assert.ok(warnings.some(w => w.includes('speed "turbo"')));
});

test('validateLadder: warns when default or officeQuiet missing', () => {
  const c = createClimate(makeStub({
    devices: { kitchen: { deviceId: 'y' } },
    ladder: { default: [['kitchen', 'low']] },
  }));
  const warnings = c.validateLadder();
  assert.ok(warnings.some(w => w.includes('officeQuiet missing')));
});

// ─── pressureToRungCount hysteresis ─────────────────────────────────────────
test('pressureToRungCount: at-or-below target -> rung 1', () => {
  const c = createClimate(makeStub({ devices: {}, ladder: { default: [], officeQuiet: [] } }));
  assert.equal(c.pressureToRungCount(0, null, 5), 1);
  assert.equal(c.pressureToRungCount(-1, null, 5), 1);
});

test('pressureToRungCount: pressure climbs engage rungs at threshold', () => {
  const c = createClimate(makeStub({ devices: {}, ladder: { default: [], officeQuiet: [] } }));
  // Thresholds in code: [1.5, 2.5, 3.5, 4.5]
  // rung 1 = baseline, rung 2 = pressure >= 1.5, ..., rung 5 = pressure >= 4.5
  assert.equal(c.pressureToRungCount(1.0, null, 5), 1);
  assert.equal(c.pressureToRungCount(1.5, null, 5), 2);
  assert.equal(c.pressureToRungCount(2.5, null, 5), 3);
  assert.equal(c.pressureToRungCount(3.5, null, 5), 4);
  assert.equal(c.pressureToRungCount(4.5, null, 5), 5);
  assert.equal(c.pressureToRungCount(99, null, 5), 5); // capped at totalRungs
});

test('pressureToRungCount: hysteresis holds previous rung above stepdown threshold', () => {
  const c = createClimate(makeStub({ devices: {}, ladder: { default: [], officeQuiet: [] } }));
  // Engaged at rung 3 (threshold 2.5). Stepdown at 2.5 - 0.5 = 2.0.
  // At pressure 2.1 with prev=3, should hold at 3.
  assert.equal(c.pressureToRungCount(2.1, 3, 5), 3);
  // At pressure 1.9 with prev=3, should drop below stepdown -> rung 2 (still above first threshold)
  assert.equal(c.pressureToRungCount(1.9, 3, 5), 2);
});

test('pressureToRungCount: step-up bypasses hysteresis', () => {
  const c = createClimate(makeStub({ devices: {}, ladder: { default: [], officeQuiet: [] } }));
  // At rung 2 with new pressure crossing threshold for rung 4 -> jumps to 4 immediately
  assert.equal(c.pressureToRungCount(3.6, 2, 5), 4);
});

test('pressureToRungCount: caps at totalRungs', () => {
  const c = createClimate(makeStub({ devices: {}, ladder: { default: [], officeQuiet: [] } }));
  // ladder has only 4 rungs; pressure 99 still returns 4
  assert.equal(c.pressureToRungCount(99, null, 4), 4);
});
