'use strict';
/**
 * The Peppol Directory, used as a source of leads and never as a source of truth.
 *
 * The SML is a keyed lookup on a hashed name, so a suffixed identifier such as
 * 0225:632012100_mandat cannot be guessed or enumerated: our own page said as much. The Directory
 * is the one public index that lists them, because SMPs push their business cards to it. We take
 * the identifiers it reports and verify each one live against the SML and the SMP, so what is
 * displayed is still our own measurement.
 *
 * Its silence is a finding in itself. Publishing to the Directory is optional and our SMP has it
 * disabled, so every participant we register is invisible to any tool built on this index.
 */
const { get } = require('./peppol.js');

const API = 'https://directory.peppol.eu/search/1.0/json';

const nameOf = (m) => {
  const e = (m.entities || [])[0] || {};
  const n = (e.name || [])[0] || {};
  return n.name || e.name || null;
};

// The schemes a French SIREN can legitimately appear under: SIRENE, SIRET, the Peppol French
// scheme, and the French VAT number. Anything else with those nine digits is another country's
// company: a Norwegian organisation number is nine digits too, and one at PowerOffice was being
// shown as a suffixed mailbox of a French SIREN.
const FR_SCHEMES = '0002|0009|0225|9957';

/**
 * Every participant the Directory holds for a SIREN, base identifier and suffixed boxes alike.
 * Matching is anchored on <scheme>:<siren> so a bare nine-digit query cannot drag in a foreign
 * identifier that merely carries those digits.
 */
function parseMatches(d, siren) {
  const anchor = new RegExp(`^(${FR_SCHEMES}):(FR)?${siren}(_|$)`, 'i');
  const listed = (d.matches || [])
    .map((m) => ({ id: m.participantID.value, nom: nameOf(m), pays: ((m.entities || [])[0] || {}).countryCode || null,
      docTypes: (m.docTypes || []).length }))
    .filter((m) => anchor.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { listed, total: d['total-result-count'] || 0 };
}

async function directoryMatches(siren) {
  return parseMatches(JSON.parse((await get(`${API}?q=${encodeURIComponent(siren)}`)).body), siren);
}

/**
 * Which of these exact identifiers the Directory publishes.
 *
 * A keyed query, unlike the full-text search above: it answers in about 100 ms where `q=` takes
 * five seconds on a SIREN the index has not been asked about lately. It cannot discover a suffix,
 * so the two coexist: this one answers "is this participant published", `q=` looks for leads.
 * A single failed call rejects the lot rather than reporting a participant as absent on a timeout.
 */
async function directoryPublished(ids) {
  const found = new Set();
  await Promise.all(ids.map(async (id) => {
    const url = `${API}?participant=${encodeURIComponent(`iso6523-actorid-upis::${id}`)}`;
    if ((JSON.parse((await get(url)).body)['total-result-count'] || 0) > 0) found.add(id);
  }));
  return found;
}

module.exports = { directoryMatches, directoryPublished, __test: { parseMatches } };
