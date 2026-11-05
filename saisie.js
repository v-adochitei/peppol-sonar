'use strict';
/**
 * Ce qui est tapé dans le champ, ramené à un identifiant ou à une raison de ne pas chercher.
 *
 * Un SIREN se copie avec des espaces, se colle depuis un numéro de TVA, et se tape de travers.
 * Sans normalisation « 810 319 517 » partait en recherche par nom, et « 810319518 » repartait avec
 * un « absente de Peppol » parfaitement assuré alors que ce numéro n'existe pas : sa clé de
 * contrôle est fausse.
 */
const { PEPPOL_ID } = require('./peppol.js');

const SUFFIXE = /^\d{9}_[A-Za-z0-9._\-+/]{1,50}$/;

/** Clé de contrôle des SIREN et SIRET (Luhn). La Poste en est la seule exception connue. */
function luhn(n) {
  if (/^356000000/.test(n)) return true;
  let t = 0;
  for (let i = 0; i < n.length; i++) {
    let d = +n[n.length - 1 - i];
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    t += d;
  }
  return t % 10 === 0;
}

/**
 * Rend `{ ident }` à sonder, `{ nom }` à chercher dans le registre, ou `{ erreur }` à afficher.
 * Le numéro de TVA français porte le SIREN dans ses neuf derniers chiffres.
 */
function saisie(q) {
  const brut = String(q || '').trim();
  if (!brut) return {};
  if (PEPPOL_ID.test(brut) || SUFFIXE.test(brut)) return { ident: brut };

  const serre = brut.replace(/[\s.\-  ]/g, '');
  const tva = /^FR[0-9A-Z]{2}(\d{9})$/i.exec(serre);
  const n = tva ? tva[1] : serre;
  if (SUFFIXE.test(n)) return { ident: n };

  if (/^\d+$/.test(n)) {
    if (n.length !== 9 && n.length !== 14) {
      return { erreur: `« ${brut} » fait ${n.length} chiffre${n.length > 1 ? 's' : ''} : un SIREN en compte 9, un SIRET 14.` };
    }
    if (!luhn(n)) {
      return { erreur: `« ${brut} » a une clé de contrôle fausse : ce ${n.length === 9 ? 'SIREN' : 'SIRET'} n'existe pas. Vérifier la saisie.` };
    }
    return { ident: n, tva: !!tva };
  }
  // Un SIREN noyé dans un copier-coller reste rattrapable ; sinon c'est un nom de société.
  const dedans = (brut.match(/\b\d{14}\b|\b\d{9}\b/g) || []).filter(luhn);
  if (dedans.length) return { ident: dedans[0] };
  return brut.length >= 3 ? { nom: brut } : { erreur: 'Saisir un SIREN, un SIRET, un numéro de TVA ou un nom de société.' };
}

module.exports = { saisie, __test: { luhn } };
