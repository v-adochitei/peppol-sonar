'use strict';
/**
 * Enumerate the SIRETs of a SIREN, so a SIREN search can cover establishment level.
 *
 * Peppol itself cannot do this: the SML is a keyed lookup, not a directory -- you can ask
 * "where is 0225:<siret>" but never "what is registered under this SIREN". So the SIRET list
 * has to come from outside, and we then probe each one.
 *
 * Two sources, on purpose:
 *  - OpenDataSoft's Sirene v3 mirror LISTS the establishments (no auth, pages of 100);
 *  - INSEE's avis-de-situation service returns only the siège but gives the AUTHORITATIVE
 *    total, so comparing the two tells us when the mirror's snapshot has drifted.
 *
 * Split in two on purpose: the SIRET list is all the Peppol probe needs, and it is the fastest
 * of the calls. Waiting for the counts before probing wasted a few hundred milliseconds on every
 * cold page.
 */
const { get, pool } = require('./peppol.js');

const ODS = 'https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/economicref-france-sirene-v3/records';
const FIELDS = [
  'siret', 'etatadministratifetablissement', 'etablissementsiege', 'libellecommuneetablissement',
  'datecreationetablissement', 'enseigne1etablissement', 'denominationusuelleetablissement',
  'denominationunitelegale',
].join(',');
const PAGE = 100;
// INSEE's avis-de-situation has answered in 35 s. All it brings is a count used to say the mirror
// may be out of date, so it gets a short leash of its own rather than the default fifteen seconds.
const INSEE_MS = 2000;
const ACTIVE = 'etatadministratifetablissement="Actif"';

const odsUrl = (params) =>
  ODS + '?' + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

async function odsRows(siren, offset) {
  const d = JSON.parse((await get(odsUrl({
    where: `siren="${siren}" and ${ACTIVE}`, limit: PAGE, offset, select: FIELDS, order_by: 'siret',
  }))).body);
  return { total: d.total_count, rows: d.results || [] };
}

/** The SIRET list, filtered on the source: counting active rows client-side under-reports. */
async function etablissementsList(siren, limit = 200) {
  const first = await odsRows(siren, 0);
  let rows = first.rows;
  if (rows.length < Math.min(limit, first.total)) {
    const offsets = [];
    for (let o = PAGE; o < Math.min(first.total, limit); o += PAGE) offsets.push(o);
    for (const p of await pool(offsets, 3, (o) => odsRows(siren, o))) rows = rows.concat(p.rows);
  }
  return {
    siren,
    activeTotal: first.total,
    denomination: (rows[0] || {}).denominationunitelegale || null,
    etablissements: rows.slice(0, limit).map((r) => ({
      siret: r.siret,
      siege: r.etablissementsiege === 'oui',
      commune: r.libellecommuneetablissement || null,
      creation: r.datecreationetablissement || null,
      enseigne: r.enseigne1etablissement || r.denominationusuelleetablissement || null,
    })).sort((a, b) => (b.siege ? 1 : 0) - (a.siege ? 1 : 0) || a.siret.localeCompare(b.siret)),
  };
}

/** Open and closed counts in ONE grouped query, plus the authoritative INSEE total. */
async function etablissementsCounts(siren) {
  const [byState, insee] = await Promise.all([
    get(odsUrl({ where: `siren="${siren}"`, group_by: 'etatadministratifetablissement', select: 'count(*) as n', limit: 20 }))
      .then((r) => JSON.parse(r.body).results || []).catch(() => []),
    get(`https://api-avis-situation-sirene.insee.fr/identification/siren/${siren}`, {}, INSEE_MS)
      .then((r) => (JSON.parse(r.body).headerEtablissements || {}).total ?? null).catch(() => null),
  ]);
  const listed = byState.reduce((n, g) => n + (g.n || 0), 0);
  const active = (byState.find((g) => g.etatadministratifetablissement === 'Actif') || {}).n || 0;
  return {
    listed,
    inseeTotal: insee,
    closed: listed - active,
    // The mirror is a snapshot: a recently created establishment can be missing from it.
    incomplete: insee != null && listed !== insee,
  };
}

module.exports = { etablissementsList, etablissementsCounts };
