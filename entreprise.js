'use strict';
/**
 * The company behind the digits, from the state's own open register.
 *
 * Peppol names nobody: it answers "where do I deliver", never "who is this". So a SIREN typed
 * here would otherwise come back unconfirmed, and a name could not be turned into a SIREN at all.
 * recherche-entreprises (DINUM) does both, publicly and without a key, which is also what lets
 * the search box accept a company name without pretending Peppol can be searched by name.
 */
const { get } = require('./peppol.js');

const API = 'https://recherche-entreprises.api.gouv.fr/search';
const url = (q, n) => `${API}?q=${encodeURIComponent(q)}&per_page=${n}&page=1`;

// nom_complet appends every registered brand, which for a large group runs past the page width.
const shape = (r) => ({
  siren: r.siren,
  nom: r.nom_raison_sociale || r.nom_complet || null,
  sigle: r.sigle || null,
  ville: (r.siege || {}).libelle_commune || null,
  cat: r.categorie_entreprise || null,
  creation: r.date_creation || null,
  cessee: r.etat_administratif === 'C',
});

/** Name and status of one SIREN, or null: never a reason to fail the page. */
async function entreprise(siren) {
  const rows = JSON.parse((await get(url(siren, 1))).body).results || [];
  const hit = rows.find((r) => r.siren === siren);
  return hit ? shape(hit) : null;
}

/** Company name to SIREN candidates, the only honest way to offer a search by name. */
async function chercheEntreprises(texte, limit = 10) {
  const d = JSON.parse((await get(url(texte, limit))).body);
  return { total: d.total_results || 0, results: (d.results || []).map(shape) };
}

module.exports = { entreprise, chercheEntreprises };
