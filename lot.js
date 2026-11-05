'use strict';
// Un lot : du texte collé vers des lignes de résultat, en 3 appels par ligne au lieu de 26.
const { saisie } = require('./saisie.js');
const { lookup, participantForms, ZONES, netCount } = require('./peppol.js');
const { directoryPublished } = require('./directory.js');

const MAX_LIGNES = 500;
// La seconde zone sert à voir le jour où les deux divergent, qui est une question de fiche.
const ZONE_LOT = [ZONES[0]];
const COLONNES = ['saisie', 'identifiant', 'statut', 'plateforme', 'hote_smp', 'adresse_livraison',
  'schemas', 'actif_depuis', 'nb_types_documents', 'annuaire_public', 'reserve', 'ms'];

// On ne lit pas un tableau, on cherche un identifiant par ligne : ni séparateur ni encodage à gérer.
function lignesDe(texte) {
  const vues = new Map();
  const rejets = [];
  let doublons = 0;
  let tronque = false;
  for (const brut of String(texte || '').split(/\r?\n/)) {
    const ligne = brut.trim();
    if (!ligne) continue;
    if (vues.size >= MAX_LIGNES) { tronque = true; break; }
    const { ident, erreur } = saisie(ligne);
    if (!ident) {
      // Le numéro noyé dans la ligne est repassé seul à la saisie, qui sait dire pourquoi il est refusé.
      const nu = (ligne.match(/\b\d{14}\b|\b\d{9}\b/g) || [])[0];
      rejets.push({ brut: ligne, motif: erreur || (nu && saisie(nu).erreur) || 'aucun identifiant reconnu dans cette ligne' });
      continue;
    }
    if (vues.has(ident)) { doublons++; continue; }
    vues.set(ident, { brut: ligne, ident });
  }
  return { lignes: [...vues.values()], rejets, doublons, tronque };
}

// La 0225 d'abord : c'est la forme sous laquelle la France enregistre.
const ordreDeSondage = (ident) =>
  participantForms(ident).sort((a, b) => (b.startsWith('0225:') ? 1 : 0) - (a.startsWith('0225:') ? 1 : 0));

const jour = (s) => (s || '').slice(0, 10);

// Ce que la page met en bannière, ramené à une colonne.
function reserveDe(d) {
  const out = [];
  for (const g of d.groups) {
    if (g.zoneConflict) out.push('les deux zones du SML désignent des serveurs différents');
    for (const z of g.zoneMissing || []) out.push(`absente de la zone ${z}`);
    if (g.certDaysLeft != null && g.certDaysLeft < 90) out.push(`certificat valide ${g.certDaysLeft} j`);
  }
  for (const f of d.failedForms) out.push(`${f.id} : ${f.errorStatus ? `HTTP ${f.errorStatus}` : f.error}`);
  if (d.groups.length > 1) out.push('deux plateformes pour ce SIREN');
  return out.join(' | ');
}

function ligneDe(entree, d, ms, publies) {
  const g = d.groups[0];
  return {
    saisie: entree.brut,
    identifiant: d.input,
    statut: d.groups.length ? 'joignable' : d.failedForms.length ? 'injoignable' : 'absente',
    plateforme: g ? (g.apCert && g.apCert.org) || g.smpHost || '' : '',
    hote_smp: g ? g.smpHost || '' : (d.failedForms[0] || {}).smpHost || '',
    adresse_livraison: g ? (g.endpoints[0] || '') : '',
    schemas: d.groups.flatMap((x) => x.schemes).join('+'),
    actif_depuis: g ? jour(g.activationFrom) : '',
    nb_types_documents: g ? String(g.docTypeCount || g.docTypes.length) : '',
    annuaire_public: publies == null ? '' : publies ? 'publiée' : 'non publiée',
    reserve: reserveDe(d),
    ms,
  };
}

// On s'arrête à la première forme qui répond : la seconde répéterait ce qu'elle a dit.
async function sonde(entree, { complet, annuaire } = {}) {
  const t0 = Date.now();
  const base = { diagnose: false };
  let d;
  if (complet) {
    d = await lookup(entree.ident, base);
  } else {
    for (const forme of ordreDeSondage(entree.ident)) {
      d = await lookup(forme, { ...base, shallow: true, zones: ZONE_LOT });
      if (d.groups.length || d.failedForms.length) break;
    }
    d.input = entree.ident;
  }
  let publies = null;
  if (annuaire && d.groups.length) {
    const ids = [...new Set(d.groups.flatMap((g) => g.ids))];
    publies = await directoryPublished(ids).then((s) => ids.some((i) => s.has(i))).catch(() => null);
  }
  return ligneDe(entree, d, Date.now() - t0, publies);
}

// Une ligne allégée n'a qu'une requête SMP en vol : la concurrence ci-dessous est donc aussi le maximum simultané chez un opérateur.
async function balaye(lignes, opts, surLigne) {
  const conc = opts.complet ? 2 : 4;
  const t0 = Date.now();
  const net0 = netCount();
  const comptes = { joignable: 0, injoignable: 0, absente: 0, erreur: 0 };
  let suivant = 0;
  await Promise.all(Array.from({ length: Math.min(conc, lignes.length) }, async () => {
    while (suivant < lignes.length) {
      const entree = lignes[suivant++];
      let ligne;
      try {
        ligne = await sonde(entree, opts);
        comptes[ligne.statut]++;
      } catch (e) {
        comptes.erreur++;
        ligne = { ...Object.fromEntries(COLONNES.map((c) => [c, ''])), saisie: entree.brut,
          identifiant: entree.ident, statut: 'erreur', reserve: String(e.message || e) };
      }
      surLigne(ligne);
    }
  }));
  return { ...comptes, lignes: lignes.length, appels: netCount() - net0, ms: Date.now() - t0 };
}

const champ = (v) => {
  const s = String(v == null ? '' : v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Point-virgule et BOM : ce qu'Excel en français ouvre sans poser de question.
const csvDe = (rows) =>
  '﻿' + [COLONNES.join(';'), ...rows.map((r) => COLONNES.map((c) => champ(r[c])).join(';'))].join('\r\n') + '\r\n';

module.exports = { lignesDe, balaye, sonde, csvDe, COLONNES, MAX_LIGNES,
  __test: { ordreDeSondage, reserveDe, champ } };
