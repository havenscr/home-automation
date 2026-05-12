// Smoke tests for sonos-commander pure helpers. Focus on the actual bug
// shapes we've hit in production: model-string capability mapping, Boost
// filtering, and the TV-mode preflight skip decision that was added on
// 2026-05-12 to suppress the spurious UPnP 402 retries on Master Bedroom.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  getModelCapabilities,
  isBoostInfo,
  shouldSkipTvJoin,
  selectJoinCandidates,
} = require('../lib/sonos-helpers');

// ─── getModelCapabilities ───────────────────────────────────────────────────
test('getModelCapabilities: Playbar gets tv capability', () => {
  assert.deepEqual(getModelCapabilities('Sonos Playbar'), ['tv']);
});

test('getModelCapabilities: Playbase gets tv capability', () => {
  assert.deepEqual(getModelCapabilities('Sonos Playbase'), ['tv']);
});

test('getModelCapabilities: Beam/Arc/Ray get tv capability', () => {
  assert.deepEqual(getModelCapabilities('Sonos Beam'), ['tv']);
  assert.deepEqual(getModelCapabilities('Sonos Arc'), ['tv']);
  assert.deepEqual(getModelCapabilities('Sonos Ray'), ['tv']);
});

test('getModelCapabilities: Five/Play:5/Port/Amp/Connect get lineIn', () => {
  assert.deepEqual(getModelCapabilities('Sonos Five'), ['lineIn']);
  assert.deepEqual(getModelCapabilities('Sonos Play:5'), ['lineIn']);
  assert.deepEqual(getModelCapabilities('Sonos Port'), ['lineIn']);
  assert.deepEqual(getModelCapabilities('Sonos Amp'), ['lineIn']);
  assert.deepEqual(getModelCapabilities('Sonos Connect:Amp'), ['lineIn']);
});

test('getModelCapabilities: Sonos One has no special caps', () => {
  assert.deepEqual(getModelCapabilities('Sonos One'), []);
});

test('getModelCapabilities: Play:1 has no caps', () => {
  assert.deepEqual(getModelCapabilities('Sonos Play:1'), []);
});

test('getModelCapabilities: handles null/empty gracefully', () => {
  assert.deepEqual(getModelCapabilities(''), []);
  assert.deepEqual(getModelCapabilities(null), []);
  assert.deepEqual(getModelCapabilities(undefined), []);
});

test('getModelCapabilities: case-insensitive', () => {
  assert.deepEqual(getModelCapabilities('PLAYBAR'), ['tv']);
  assert.deepEqual(getModelCapabilities('sonos five'), ['lineIn']);
});

// ─── isBoostInfo ────────────────────────────────────────────────────────────
test('isBoostInfo: Sonos Boost identified', () => {
  assert.equal(isBoostInfo({ model: 'Sonos Boost' }), true);
});

test('isBoostInfo: non-Boost speakers are not', () => {
  assert.equal(isBoostInfo({ model: 'Sonos One' }), false);
  assert.equal(isBoostInfo({ model: 'Sonos Playbar' }), false);
});

test('isBoostInfo: handles missing/null info', () => {
  assert.equal(isBoostInfo(null), false);
  assert.equal(isBoostInfo(undefined), false);
  assert.equal(isBoostInfo({}), false);
  assert.equal(isBoostInfo({ model: null }), false);
});

// ─── shouldSkipTvJoin (the preflight decision from May 12 fix) ──────────────
test('shouldSkipTvJoin: Playbar in TV mode -> skip', () => {
  // The exact bug shape from 2026-05-12: Master Bedroom Playbar with TV input
  // active. The preflight skips it so we don't waste a 402-error retry.
  assert.equal(shouldSkipTvJoin(['tv'], { inputSource: 'TV' }), true);
});

test('shouldSkipTvJoin: Playbar playing music (not TV) -> do not skip', () => {
  // MBR is TV-capable but currently playing music. It CAN be a slave.
  assert.equal(shouldSkipTvJoin(['tv'], { inputSource: null }), false);
  assert.equal(shouldSkipTvJoin(['tv'], { inputSource: 'Line In' }), false);
});

test('shouldSkipTvJoin: non-TV-capable speaker is never skipped by this rule', () => {
  // A Sonos One on TV input is impossible, but defensively: even if currentState
  // claims inputSource:'TV', a speaker without 'tv' capability is not skipped.
  // The preflight only fires for TV-capable speakers.
  assert.equal(shouldSkipTvJoin([], { inputSource: 'TV' }), false);
  assert.equal(shouldSkipTvJoin(['lineIn'], { inputSource: 'TV' }), false);
});

test('shouldSkipTvJoin: missing state defaults to no-skip', () => {
  // If we can't read the speaker's state, don't pre-skip -- let the join attempt
  // happen and fall back to retry if it 402's. Safer than silently dropping a speaker.
  assert.equal(shouldSkipTvJoin(['tv'], null), false);
  assert.equal(shouldSkipTvJoin(['tv'], undefined), false);
});

test('shouldSkipTvJoin: missing capabilities defaults to no-skip', () => {
  assert.equal(shouldSkipTvJoin(null, { inputSource: 'TV' }), false);
  assert.equal(shouldSkipTvJoin(undefined, { inputSource: 'TV' }), false);
});

// ─── selectJoinCandidates ───────────────────────────────────────────────────
test('selectJoinCandidates: excludes coordinator from join list', () => {
  const all = ['Bathroom', 'Kitchen', 'Office Speaker'];
  const info = {
    Bathroom: { model: 'Sonos One' },
    Kitchen: { model: 'Sonos Play:1' },
    'Office Speaker': { model: 'Sonos Five' },
  };
  const result = selectJoinCandidates(all, 'Bathroom', new Set(), info);
  assert.deepEqual(result.sort(), ['Kitchen', 'Office Speaker']);
});

test('selectJoinCandidates: excludes Boost devices', () => {
  // This is the actual production setup -- Boost at 192.168.1.15 must never
  // be sent UPnP commands.
  const all = ['Bathroom', 'Kitchen', 'Boost'];
  const info = {
    Bathroom: { model: 'Sonos One' },
    Kitchen: { model: 'Sonos Play:1' },
    Boost: { model: 'Sonos Boost' },
  };
  const result = selectJoinCandidates(all, 'Bathroom', new Set(), info);
  assert.deepEqual(result, ['Kitchen']);
});

test('selectJoinCandidates: excludes already-grouped speakers', () => {
  const all = ['Bathroom', 'Kitchen', 'Office Speaker', 'Master Bedroom'];
  const info = {
    Bathroom: { model: 'Sonos One' },
    Kitchen: { model: 'Sonos Play:1' },
    'Office Speaker': { model: 'Sonos Five' },
    'Master Bedroom': { model: 'Sonos Playbar' },
  };
  const alreadyGrouped = new Set(['Kitchen', 'Office Speaker']);
  const result = selectJoinCandidates(all, 'Bathroom', alreadyGrouped, info);
  assert.deepEqual(result, ['Master Bedroom']);
});

test('selectJoinCandidates: accepts alreadyGrouped as plain array', () => {
  const all = ['Bathroom', 'Kitchen'];
  const info = {
    Bathroom: { model: 'Sonos One' },
    Kitchen: { model: 'Sonos Play:1' },
  };
  const result = selectJoinCandidates(all, 'Bathroom', ['Kitchen'], info);
  assert.deepEqual(result, []);
});

test('selectJoinCandidates: real production speaker set', () => {
  // Mirrors the actual 6-speaker + 1-Boost setup we have on the Pi.
  const all = ['Bathroom', 'Playbase', 'Master Bedroom', 'Guest Bathroom Speaker',
               'Office Speaker', 'Kitchen', 'Boost'];
  const info = {
    Bathroom: { model: 'Sonos One' },
    Playbase: { model: 'Sonos Playbase' },
    'Master Bedroom': { model: 'Sonos Playbar' },
    'Guest Bathroom Speaker': { model: 'Sonos One' },
    'Office Speaker': { model: 'Sonos Five' },
    Kitchen: { model: 'Sonos Play:1' },
    Boost: { model: 'Sonos Boost' },
  };
  // Bathroom as coord, nothing pre-grouped. Should yield the 5 other non-Boost speakers.
  const result = selectJoinCandidates(all, 'Bathroom', new Set(), info);
  assert.equal(result.length, 5);
  assert.ok(!result.includes('Boost'));
  assert.ok(!result.includes('Bathroom'));
});
