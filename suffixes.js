'use strict';
// Un suffixe libre ne s'énumère pas : on essaie ceux qu'on a déjà vus. C'est une devinette, pas un inventaire.
const { lookup, pool, resoutDansSml } = require('./peppol.js');

// Noms de plateformes et mots métier relevés sur des identifiants réels ou proposés par leurs documentations.
const SUFFIXES = [
  'inqom', 'chaintrust', 'pennylane', 'tiime', 'sage', 'serensia', 'qonto', 'tessi', 'invopop',
  'sedeb2b', 'itesoft', 'apifirst', 'cegedim', 'docaposte', 'esker', 'generix', 'freedz', 'yooz',
  'digtech', 'mandat', 'mandats', 'achat', 'achatpub', 'vente', 'ventes', 'facture', 'factures',
  'invoice', 'compta', 'admin', 'principal', 'siege', 'notesdefrais', 'marchespublics',
];

const candidats = (siren, connus = []) => {
  const deja = new Set(connus.map((c) => c.toLowerCase()));
  return [...new Set(SUFFIXES.map((s) => `0225:${siren}_${s}`))].filter((p) => !deja.has(p.toLowerCase()));
};

// Deux temps : le DNS écarte la quasi-totalité des candidats, seules les touches coûtent une lecture SMP.
async function sondeSuffixes(siren, connus = []) {
  const liste = candidats(siren, connus);
  const touches = (await pool(liste, 8, (p) => resoutDansSml(p).then((ok) => (ok ? p : null)).catch(() => null))).filter(Boolean);
  const fiches = await pool(touches, 4, (p) => lookup(p, { diagnose: false, shallow: true }).catch(() => null));
  return { essayes: liste.length, trouves: fiches.filter((r) => r && r.groups.length) };
}

module.exports = { sondeSuffixes, SUFFIXES, __test: { candidats } };
