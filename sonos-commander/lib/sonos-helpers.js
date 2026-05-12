// Pure helpers for sonos-commander, extracted for unit-testability.
// Original implementations live in server.js and read from module globals
// (speakers, speakerInfo). These versions take everything as explicit
// arguments so they can be tested without booting the whole service.

// Map a Sonos model string to capability tags.
// "tv" => HDMI/optical input (Playbar/Playbase/Beam/Arc/Ray)
// "lineIn" => 3.5mm or auto-detect (Five/Play:5/Port/Amp/Connect)
function getModelCapabilities(model) {
  const m = (model || '').toLowerCase();
  const caps = [];
  if (m.includes('five') || m.includes('play:5') || m.includes('port') || m.includes('amp') || m.includes('connect')) {
    caps.push('lineIn');
  }
  if (m.includes('playbase') || m.includes('playbar') || m.includes('beam') || m.includes('arc') || m.includes('ray')) {
    caps.push('tv');
  }
  return caps;
}

// Pure form of isBoost: takes a speakerInfo entry directly instead of reading
// a module global. Returns true if the model string contains "Boost".
function isBoostInfo(info) {
  return !!(info && info.model && info.model.indexOf('Boost') !== -1);
}

// Decide whether a TV-capable speaker should be preflight-skipped from a
// group-join attempt. Returns true if the speaker has the 'tv' capability AND
// its current inputSource is 'TV' (meaning it's actively playing TV/HDMI
// audio and will refuse a slave-join with UPnP 402). Otherwise false.
//
// This is the same decision the groupAllSpeakers preflight makes inline;
// extracted as a pure function so test cases can pin down each branch.
function shouldSkipTvJoin(capabilities, currentState) {
  if (!capabilities || !capabilities.includes('tv')) return false;
  if (!currentState) return false;
  return currentState.inputSource === 'TV';
}

// Build the list of speaker names to join in a groupAllSpeakers call, given
// the full set of known speakers, the coordinator name, and the set of names
// already grouped under the coordinator. Filters out the coordinator itself,
// any Boost devices, and already-grouped speakers.
//
// Returns names only; the actual join is done by the caller with the device
// handles. Pure function -- pass speakerInfo entries as a plain object.
function selectJoinCandidates(allSpeakerNames, coordName, alreadyGrouped, speakerInfoMap) {
  const already = alreadyGrouped instanceof Set ? alreadyGrouped : new Set(alreadyGrouped || []);
  return allSpeakerNames.filter(name => {
    if (name === coordName) return false;
    if (already.has(name)) return false;
    const info = speakerInfoMap[name];
    if (isBoostInfo(info)) return false;
    return true;
  });
}

module.exports = {
  getModelCapabilities,
  isBoostInfo,
  shouldSkipTvJoin,
  selectJoinCandidates,
};
