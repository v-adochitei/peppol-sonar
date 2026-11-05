'use strict';
/**
 * Regression tests. Pure functions only: no DNS, no HTTP, so they run offline and fast.
 *
 *   node --test
 *
 * Every case here is a bug we actually shipped, or a rule that would drift silently.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { __test, PEPPOL_ID } = require('./peppol.js');
const { dnsName, participantForms, sirenOf, describeDocType, apCert, smpCert, allTags, mergeForms } = __test;

test('le nom DNS est le hachage de la valeur d\'identifiant, pas de la forme URI', () => {
  // Valeurs relevées sur le SML de production : si l'algorithme dérive, ces labels changent
  // et plus rien ne résout, sans erreur visible.
  assert.strictEqual(
    dnsName('0225:810319517', 'edelivery.tech.ec.europa.eu'),
    'e2uw3luof6cvuwmarzyeewhin2td5gijfc3e6rvfk2lc4crdmcba.iso6523-actorid-upis.edelivery.tech.ec.europa.eu'
  );
  assert.strictEqual(
    dnsName('0002:810319517', 'edelivery.tech.ec.europa.eu'),
    'ucubu33hm7njmixzoe3uszjh5ceqdaayq47xumt5cjcvaglelbfq.iso6523-actorid-upis.edelivery.tech.ec.europa.eu'
  );
  // Le hachage est insensible à la casse de l'entrée.
  assert.strictEqual(dnsName('0225:ABC', 'z'), dnsName('0225:abc', 'z'));
});

test('les formes de participant suivent les règles de notre propre enregistrement', () => {
  // Duplication assumée : si les schémas changent sur notre plateforme, ce test doit échouer ici.
  assert.deepStrictEqual(participantForms('810319517'), ['0002:810319517', '0225:810319517']);
  assert.deepStrictEqual(participantForms('81031951700019'),
    ['0009:81031951700019', '0225:810319517_81031951700019']);
  assert.deepStrictEqual(participantForms('0208:0739910951'), ['0208:0739910951']);
  assert.deepStrictEqual(participantForms('12345'), []);
  assert.deepStrictEqual(participantForms('dougs'), []);
});

test('un identifiant Peppol complet est reconnu, une valeur nue non', () => {
  assert.ok(PEPPOL_ID.test('0225:810319517'));
  assert.ok(PEPPOL_ID.test('0225:922078522_STATUTS'));
  assert.ok(!PEPPOL_ID.test('810319517'));
  assert.ok(!PEPPOL_ID.test('0225:'));
});

test('les libellés de doctypes distinguent CIUS et étendu', () => {
  const l = (id) => describeDocType(id).label;
  assert.strictEqual(l('urn:peppol:doctype:pdf+xml##urn:cen.eu:en16931:2017#conformant#urn:peppol:france:billing:Factur-X:1.0::D22B'), 'Factur-X');
  assert.strictEqual(l('urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:cen.eu:en16931:2017#compliant#urn:peppol:france:billing:cius:1.0::2.1'), 'Facture UBL (CIUS)');
  assert.strictEqual(l('urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:cen.eu:en16931:2017#conformant#urn:peppol:france:billing:extended:1.0::2.1'), 'Facture UBL (étendu)');
  assert.strictEqual(l('urn:un:unece:uncefact:data:standard:CrossDomainAcknowledgementAndResponse:100::CrossDomainAcknowledgementAndResponse##urn:peppol:france:billing:cdv:1.0::D22B'), 'Statuts de cycle de vie');
  assert.strictEqual(describeDocType('urn:x::Y##urn:z::2.1').version, '2.1');
});

test('une balise se lit sous n\'importe quel préfixe de namespace', () => {
  // Régression réelle : peppol.sh cherchait <wsa:Address> en dur et ratait l'adresse d'un SMP
  // polonais qui utilise un autre préfixe.
  assert.deepStrictEqual(allTags('<wsa:Address>https://a/</wsa:Address>', 'Address'), ['https://a/']);
  assert.deepStrictEqual(allTags('<ns2:Address>https://b/</ns2:Address>', 'Address'), ['https://b/']);
  assert.deepStrictEqual(allTags('<Address>https://c/</Address>', 'Address'), ['https://c/']);
});

// Deux certificats auto-signés distincts, pour vérifier qu'on ne confond pas les deux balises.
const { execSync } = require('node:child_process');
function selfSigned(cn) {
  const out = execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout /dev/null -nodes -days 5 -subj "/C=FR/O=${cn}/OU=T/CN=${cn}" -outform DER 2>/dev/null | base64`,
    { shell: '/bin/bash', maxBuffer: 1 << 20 }
  ).toString().replace(/\s+/g, '');
  return out;
}

test('le certificat du point d\'accès ne se confond pas avec celui du SMP', () => {
  // Régression de conception : <ds:X509Certificate> finit par "Certificate" lui aussi, donc une
  // regex trop lâche lit la signature du SMP à la place du certificat AP.
  const ap = selfSigned('AP-ORG');
  const sm = selfSigned('SMP-ORG');
  const smp = `<Signature><KeyInfo><X509Data><ds:X509Certificate>${sm}</ds:X509Certificate></X509Data></KeyInfo></Signature>`;
  const meta = `<smp:ServiceMetadata><smp:Certificate>${ap}</smp:Certificate></smp:ServiceMetadata>`;
  for (const xml of [meta + smp, smp + meta]) {   // les deux ordres : le sélecteur doit être précis, pas chanceux
    assert.strictEqual(apCert(xml).org, 'AP-ORG');
    assert.strictEqual(smpCert(xml).org, 'SMP-ORG');
  }
});

const form = (o) => ({
  id: o.id, scheme: o.id.split(':')[0], status: o.status || 'ok',
  zones: [], zoneConflict: false, zoneSilent: [],
  smpHost: o.smp || null, endpoints: o.endpoints || [], transportProfiles: [], processIds: [],
  activationDates: o.act || [], expirationDates: o.exp || [], docTypes: o.docs || [],
  apCert: o.ap ? { org: o.ap, cn: o.cn || o.ap, daysLeft: 500 } : null,
  smpCert: o.smpOrg ? { org: o.smpOrg } : null,
  contacts: [], infoUrls: [], descriptions: o.desc || [], failedDocTypes: [], evidence: { serviceGroupUrl: 'u', serviceMetadataUrls: [] },
  error: o.error || null,
});

test('deux identifiants identiques fusionnent en un seul groupe', () => {
  const r = mergeForms([
    form({ id: '0002:1', ap: 'API FIRST', smp: 'smp.a', endpoints: ['https://as4/'] }),
    form({ id: '0225:1', ap: 'API FIRST', smp: 'smp.a', endpoints: ['https://as4/'] }),
  ]);
  assert.strictEqual(r.groups.length, 1);
  assert.deepStrictEqual(r.groups[0].ids, ['0002:1', '0225:1']);
});

test('deux identifiants qui divergent donnent deux groupes', () => {
  // Le cas 999991029 : 0002 chez nous, 0225 ailleurs. C'est la trouvaille de l'outil.
  const r = mergeForms([
    form({ id: '0002:1', ap: 'API FIRST', cn: 'A', smp: 'smp.a', endpoints: ['https://a/'] }),
    form({ id: '0225:1', ap: 'SUPER G', cn: 'B', smp: 'smp.b', endpoints: ['https://b/'] }),
  ]);
  assert.strictEqual(r.groups.length, 2);
});

test('un schéma absent est listé, il ne fabrique pas de groupe', () => {
  const r = mergeForms([
    form({ id: '0002:1', status: 'absent' }),
    form({ id: '0225:1', ap: 'TIIME PDP', smp: 'smp.t', endpoints: ['https://t/'] }),
  ]);
  assert.deepStrictEqual(r.absentSchemes, ['0002']);
  assert.strictEqual(r.groups.length, 1);
});

test('enregistré mais injoignable n\'est pas absent', () => {
  // Régression réelle sur 999991102 : la page titrait « absente » alors que 0225 est enregistré.
  const r = mergeForms([
    form({ id: '0002:1', status: 'absent' }),
    form({ id: '0225:1', status: 'error', smp: 'smp-peppol.viaadvalvas.com', error: 'aucun service publié' }),
  ]);
  assert.strictEqual(r.groups.length, 0);
  assert.strictEqual(r.failedForms.length, 1);
  assert.strictEqual(r.failedForms[0].smpHost, 'smp-peppol.viaadvalvas.com');
});

test('opérer son propre SMP se déduit des deux certificats', () => {
  const own = mergeForms([form({ id: '0225:1', ap: 'API FIRST', smpOrg: 'API FIRST', smp: 's', endpoints: ['e'] })]);
  assert.strictEqual(own.groups[0].selfHosted, true);
  const hosted = mergeForms([form({ id: '0225:1', ap: 'TIIME PDP', smpOrg: 'Axway', smp: 's', endpoints: ['e'] })]);
  assert.strictEqual(hosted.groups[0].selfHosted, false);
});

test('aucune date d\'expiration de fiche n\'est retenue : chaque type de document a la sienne', () => {
  const tot = new Date(Date.now() + 10 * 86400000).toISOString();
  const tard = new Date(Date.now() + 300 * 86400000).toISOString();
  const r = mergeForms([form({ id: '0225:1', ap: 'X', smp: 's', endpoints: ['e'], exp: [tot, tard] })]);
  assert.strictEqual(r.groups[0].expirationTo, undefined);
  assert.strictEqual(r.groups[0].endpointDaysLeft, undefined);
});

const { __test: dir } = require('./directory.js');

test('le Directory ne rend que les identifiants ancrés sur le SIREN demandé', () => {
  const r = dir.parseMatches({ 'total-result-count': 4, matches: [
    { participantID: { value: '0225:632012100' }, docTypes: [1, 2], entities: [{ name: [{ name: "L'OREAL FRANCE" }], countryCode: 'FR' }] },
    { participantID: { value: '0225:632012100_mandat' }, docTypes: [], entities: [] },
    { participantID: { value: '9957:FR632012100' }, docTypes: [], entities: [] },
    { participantID: { value: '0088:7612345632012100' }, docTypes: [], entities: [] },
  ] }, '632012100');
  assert.deepStrictEqual(r.listed.map((m) => m.id), ['0225:632012100', '0225:632012100_mandat', '9957:FR632012100']);
  assert.strictEqual(r.listed[0].nom, "L'OREAL FRANCE");
  assert.strictEqual(r.listed[0].docTypes, 2);
});

test('un numéro étranger de neuf chiffres identiques au SIREN est écarté', () => {
  const r = dir.parseMatches({ 'total-result-count': 1, matches: [
    { participantID: { value: '0192:999991037' }, docTypes: [], entities: [{ name: [{ name: 'EXEMPLE AS' }], countryCode: 'NO' }] },
  ] }, '999991037');
  assert.deepStrictEqual(r.listed, []);
});

test('un SIREN absent du Directory donne une liste vide, pas une erreur', () => {
  assert.deepStrictEqual(dir.parseMatches({ 'total-result-count': 0, matches: [] }, '999991060').listed, []);
});

const pki = require('./pki.js');

test('la chaîne Peppol épinglée se vérifie contre elle-même', () => {
  assert.ok(pki.selfTest());
});

test('un certificat hors PKI Peppol est signalé inconnu, pas invalide', () => {
  const { X509Certificate, generateKeyPairSync } = require('node:crypto');
  const root = pki.ANCHORS.find((a) => a.subject === a.issuer);
  assert.strictEqual(pki.verifyIssuer(root).state, 'verifie');
  assert.strictEqual(pki.verifyIssuer(null).state, 'illisible');
  // An anchor is only an anchor for what it signed: the SMP CA did not issue the AP CA.
  const ap = pki.ANCHORS.find((a) => /ACCESS POINT/.test(a.subject));
  const smp = pki.ANCHORS.find((a) => /SERVICE METADATA/.test(a.subject));
  assert.strictEqual(ap.checkIssued(smp), false);
  assert.ok(ap.checkIssued(root) && ap.verify(root.publicKey));
});

test('une panne de SMP se lit en français, le code HTTP en second', () => {
  const r = mergeForms([{ ...form({ id: '0225:1', smp: 'smp.x' }), status: 'error', error: 'ServiceGroup HTTP 504', errorStatus: 504 }]);
  assert.strictEqual(r.failedForms[0].errorStatus, 504);
});

test('une panne de SMP entier se distingue d\'une fiche illisible', () => {
  const down = { ...form({ id: '0225:1', smp: 'smp.x' }), status: 'error', error: 'ServiceGroup HTTP 504',
    errorStatus: 504, smpAlive: { alive: false, status: null, error: 'timeout' } };
  const up = { ...down, smpAlive: { alive: true, status: 404 } };
  assert.strictEqual(mergeForms([down]).failedForms[0].smpAlive.alive, false);
  assert.strictEqual(mergeForms([up]).failedForms[0].smpAlive.alive, true);
});

const { __test: vue, resultMain } = require('./render.js');

test('une boîte suffixée qui répond interdit le verdict « absente de Peppol »', () => {
  const d = { input: '999991052', groups: [], failedForms: [], absentSchemes: ['0002', '0225'] };
  const boite = { input: '0225:999991052_0147_replyto', groups: [{ apCert: { org: 'Serensia' }, smpHost: 's', zoneSilent: [] }] };
  assert.ok(vue.banners(d, []).includes('Absente de Peppol'));
  const avec = vue.banners(d, [boite]);
  assert.ok(!avec.includes('Absente de Peppol'));
  assert.ok(avec.includes('0225:999991052_0147_replyto') && avec.includes('Serensia'));
});

test('un SIRET absent renvoie vers son SIREN quand celui-ci répond', () => {
  const d = { input: '38905844700050', groups: [], failedForms: [], absentSchemes: ['0009', '0225'] };
  const parent = { groups: [{ apCert: { org: 'Basware Corporation' }, smpHost: 's', zoneSilent: [] }] };
  const b = vue.banners(d, [], parent, '389058447');
  assert.ok(!b.includes('Absente de Peppol'));
  assert.ok(b.includes('établissement n\'est pas enregistré') && b.includes('Basware Corporation'));
  assert.ok(b.includes('href="/?q=389058447"'));
});

test('un identifiant suffixé collé sans son schéma est développé en 0225', () => {
  assert.deepStrictEqual(participantForms('389058447_card'), ['0225:389058447_card']);
  assert.deepStrictEqual(participantForms('389058447_'), []);
  assert.strictEqual(sirenOf('389058447_card'), '389058447');
  assert.strictEqual(sirenOf('0225:389058447_card'), '389058447');
  assert.strictEqual(sirenOf('0009:38905844700050'), '389058447');
  // A foreign scheme has no SIREN inside it, whatever the leading digits look like.
  assert.strictEqual(sirenOf('0208:0656842527'), null);
});

test('le verdict « suffixe uniquement » porte le lien vers la boîte qui répond', () => {
  const d = { input: '440283752', groups: [], failedForms: [], absentSchemes: ['0002', '0225'] };
  const boite = { input: '0225:440283752_achatpub_999991136', groups: [{ apCert: { org: 'ICD' }, smpHost: 's', zoneSilent: [] }] };
  const b = vue.banners(d, [boite]);
  assert.ok(b.includes('href="/?q=0225%3A440283752_achatpub_999991136"'));
});

test('un identifiant injoignable indique celui qui répond, sans effacer la panne', () => {
  const d = { input: '0225:819489626_achatpub_dentsux', groups: [], absentSchemes: [],
    failedForms: [{ id: '0225:819489626_achatpub_dentsux', smpHost: 'peppol.sedeb2b.com', error: 'aucun service publié', errorStatus: null }] };
  const boite = { input: '0225:819489626_invopop', groups: [{ apCert: { org: 'Invopop' }, smpHost: 's', zoneSilent: [] }] };
  const parent = { groups: [{ apCert: { org: 'Sovos Saphety' }, smpHost: 's', zoneSilent: [] }] };
  const b = vue.banners(d, [boite], parent, '819489626');
  assert.ok(b.includes('peppol.sedeb2b.com') && b.includes('aucun service publié'));
  assert.ok(b.includes('En revanche') && b.includes('Sovos Saphety') && b.includes('Invopop'));
  assert.ok(b.includes('href="/?q=819489626"') && b.includes('href="/?q=0225%3A819489626_invopop"'));
});

test('plusieurs cibles donnent une liste cliquable, une seule garde le bouton', () => {
  const d = { input: '498019298', groups: [], failedForms: [], absentSchemes: ['0002', '0225'] };
  const b = (n) => ({ input: `0225:498019298_b${n}`, nom: 'Sendinblue SAS',
    groups: [{ apCert: { org: 'Invopop' }, smpHost: 's', zoneSilent: [] }] });
  const trois = vue.banners(d, [b(1), b(2), b(3)]);
  assert.strictEqual((trois.match(/class="pick"/g) || []).length, 3);
  assert.ok(!trois.includes('class="ghost"'));
  const une = vue.banners(d, [b(1)]);
  assert.ok(une.includes('class="ghost"') && !une.includes('class="pick"'));
});

const { saisie, __test: sai } = require('./saisie.js');

test('la saisie encaisse les espaces, la TVA, et refuse une clé fausse', () => {
  assert.strictEqual(saisie('810 319 517').ident, '810319517');
  assert.strictEqual(saisie('810.319.517').ident, '810319517');
  assert.strictEqual(saisie('FR47810319517').ident, '810319517');
  assert.strictEqual(saisie('0225:810319517').ident, '0225:810319517');
  assert.strictEqual(saisie('810319517_card').ident, '810319517_card');
  assert.ok(/clé de contrôle/.test(saisie('810319518').erreur));
  assert.ok(/9|14/.test(saisie('12345').erreur));
  assert.strictEqual(saisie('decathlon').nom, 'decathlon');
  // La Poste est la seule exception connue à la clé de Luhn.
  assert.ok(sai.luhn('356000000'));
  assert.ok(sai.luhn('810319517') && !sai.luhn('810319518'));
});

test('rejouer une fiche ne vide que son propre cache', async () => {
  const P = require('./peppol.js');
  P.clearCache();
  await P.lookup('810319517').catch(() => {});
  const avant = P.netCount();
  assert.ok(P.clearFor('999999999', '999999999') === 0, 'un autre identifiant ne touche à rien');
  await P.lookup('810319517').catch(() => {});
  assert.strictEqual(P.netCount(), avant, 'la fiche est toujours en cache');
});

test('un établissement enregistré à part a ses identifiants dans le tableau, et la carte le dit', () => {
  const e = { siren: '999991003', activeTotal: 1, listed: 1, etablissements: [{ siret: '99999100300008', siege: true, commune: 'BRON' }] };
  const d = { input: '999991003', groups: [], failedForms: [], forms: [{ id: '0002:999991003' }, { id: '0225:999991003' }] };
  const trouve = [{ input: '99999100300008', failedForms: [], groups: [{ ids: ['0009:99999100300008', '0225:999991003_99999100300008'], schemes: ['0009', '0225'], apCert: { org: 'API FIRST' }, smpHost: 's', activationFrom: '2026-06-02' }] }];
  // La forme SIRET n'apparaît nulle part ailleurs : le Peppol Directory ne la connaît pas.
  const t = vue.identifiants(d, { siren: '999991003', etabs: e, probed: trouve });
  assert.match(t, /0009:99999100300008<br>0225:999991003_99999100300008<br><span class="sec">BRON · siège<\/span>/);
  assert.match(vue.etabSection(e, trouve), /avec son propre enregistrement Peppol, listé dans les identifiants/);
  assert.strictEqual(vue.etabSection(e, [{ input: '99999100300008', groups: [], failedForms: [] }]), '');
  // Enregistré mais illisible : le SML le donne, donc la ligne reste, sinon l'info disparaît.
  const casse = [{ input: '99999100300008', groups: [],
    failedForms: [{ id: '0225:999991003_99999100300008', smpHost: 'peppol-smp.digitalinvoice.tessi.eu', errorStatus: 404, error: 'ServiceGroup HTTP 404' }] }];
  const ligne = vue.identifiants(d, { siren: '999991003', etabs: e, probed: casse });
  assert.match(ligne, /sans fiche/);
  assert.match(ligne, /tessi\.eu/);
  assert.match(ligne, /HTTP 404/);
  assert.match(vue.etabSection(e, casse), /listé dans les identifiants/);
});

const lot = require('./lot.js');

test('une ligne de CSV donne son premier identifiant valide, quel que soit le séparateur', () => {
  const r = lot.lignesDe('siren;nom;ville\n999991003;EXEMPLE;BRON\n"DOUGS",999991060,75002\n0225:999991037');
  assert.deepStrictEqual(r.lignes.map((l) => l.ident), ['999991003', '999991060', '0225:999991037']);
  // L'en-tête n'est pas deviné : il est écarté parce qu'il ne porte aucun identifiant valide.
  assert.strictEqual(r.rejets[0].brut, 'siren;nom;ville');
});

test('un numéro refusé dans une ligne bavarde garde le motif exact du refus', () => {
  const r = lot.lignesDe('810319518;faute de frappe\n123\nune ligne sans rien');
  assert.match(r.rejets[0].motif, /clé de contrôle fausse/);
  assert.match(r.rejets[1].motif, /un SIREN en compte 9/);
  // Hors d'un nombre de 9 ou 14 chiffres, on ne devine pas ce que la ligne voulait dire.
  assert.strictEqual(r.rejets[2].motif, 'aucun identifiant reconnu dans cette ligne');
  assert.strictEqual(r.lignes.length, 0);
});

test('les doublons sont comptés et le plafond tronque sans tout jeter', () => {
  const r = lot.lignesDe('999991003\n999 991 003\n\n999991060');
  assert.deepStrictEqual(r.lignes.map((l) => l.ident), ['999991003', '999991060']);
  assert.strictEqual(r.doublons, 1);
  const trop = lot.lignesDe(Array.from({ length: lot.MAX_LIGNES + 5 }, (_, i) => `99999100${i % 10}`).join('\n'));
  assert.ok(trop.lignes.length <= lot.MAX_LIGNES);
});

test('la forme 0225 est sondée avant les autres, car la France enregistre sous celle-là', () => {
  assert.deepStrictEqual(lot.__test.ordreDeSondage('999991003'), ['0225:999991003', '0002:999991003']);
  assert.deepStrictEqual(lot.__test.ordreDeSondage('99999100300008'), ['0225:999991003_99999100300008', '0009:99999100300008']);
});

test('un champ CSV qui porte le séparateur ou un guillemet est entouré et échappé', () => {
  assert.strictEqual(lot.__test.champ('a;b'), '"a;b"');
  assert.strictEqual(lot.__test.champ('dit "oui"'), '"dit ""oui"""');
  assert.strictEqual(lot.__test.champ('simple'), 'simple');
  assert.ok(lot.csvDe([{ saisie: 'x' }]).startsWith('﻿' + lot.COLONNES.join(';')));
});

test('la colonne réserve reprend ce que la page met en bannière', () => {
  const d = { groups: [{ zoneConflict: false, zoneMissing: ['edelivery.tech.ec.europa.eu'], certDaysLeft: 12 }], failedForms: [] };
  const r = lot.__test.reserveDe(d);
  assert.match(r, /absente de la zone edelivery/);
  assert.match(r, /certificat valide 12 j/);
  assert.doesNotMatch(r, /adresse de livraison/);
  assert.strictEqual(lot.__test.reserveDe({ groups: [{ zoneMissing: [] }], failedForms: [] }), '');
});

test('ce que la zone en retrait traîne encore est une note, pas un verdict', () => {
  const d = { input: '0225:999991078', groups: [], failedForms: [], absentSchemes: ['0225'],
    forms: [{ id: '0225:999991078', status: 'absent', zoneSilent: [],
      reliquats: [{ zone: 'edelivery.tech.ec.europa.eu', smp: 'smp.pennylane.com' }] }] };
  // Le verdict est l'absence, sans un mot sur la zone en retrait : elle ne décide plus rien.
  const b = vue.banners(d, []);
  assert.match(b, /Absente de Peppol/);
  assert.doesNotMatch(b, /edelivery/);
  const note = vue.reliquat(d);
  assert.match(note, /edelivery\.tech\.ec\.europa\.eu/);
  assert.match(note, /smp\.pennylane\.com/);
  assert.match(note, /2 septembre 2026/);
  assert.strictEqual(vue.reliquat({ forms: [{ id: '0225:1', reliquats: [] }] }), '');
});

test('0225 muet pendant que 0002 répond se signale, l\'inverse non', () => {
  const groupe = { ids: ['0002:999991045'], schemes: ['0002'], apCert: { org: 'API FIRST' }, smpHost: 's', zoneSilent: [], reliquats: [] };
  const casse = { input: '999991045', groups: [groupe], failedForms: [],
    forms: [{ id: '0002:999991045', status: 'ok' }, { id: '0225:999991045', status: 'absent' }] };
  const b = vue.banners(casse, []);
  assert.match(b, /ne sont pas dans le même état/);
  assert.match(b, /adresse exactement <code>0002:999991045<\/code>/);
  // 0002 absent pendant que 0225 répond est la configuration courante hors de chez nous : silence.
  const normal = { input: '632012100', groups: [{ ...groupe, ids: ['0225:632012100'], schemes: ['0225'] }], failedForms: [],
    forms: [{ id: '0002:632012100', status: 'absent' }, { id: '0225:632012100', status: 'ok' }] };
  assert.doesNotMatch(vue.banners(normal, []), /ne sont pas dans le même état/);
});



const suf = require('./suffixes.js');

test('les candidats à suffixe excluent ce qu\'on connaît déjà, sans égard à la casse', () => {
  const c = suf.__test.candidats('999991011', ['0225:999991011_INQOM', '0225:999991011']);
  assert.ok(c.length > 20 && c.length < suf.SUFFIXES.length + 1);
  assert.ok(!c.some((x) => /_inqom$/i.test(x)));
  assert.ok(c.every((x) => x.startsWith('0225:999991011_')));
  assert.strictEqual(new Set(c).size, c.length);
});

const groupe = (id, org, extra = {}) => ({ ids: [id], schemes: [id.slice(0, 4)], apCert: { org, issue: { state: 'verifie' } },
  smpCert: { org }, selfHosted: true, smpHost: 's', endpoints: ['e'], docTypes: [], zoneSilent: [], reliquats: [], zones: [],
  evidence: [], contacts: [], infoUrls: [], descriptions: [], failedDocTypes: [], processIds: [], activationFrom: '2026-02-09', activationTo: '2026-02-09', ...extra });

test('les suffixes essayés tiennent dans le tableau, et leur silence ne prouve rien', () => {
  const d = { input: '999991011', groups: [], failedForms: [], forms: [{ id: '0002:999991011' }, { id: '0225:999991011' }] };
  const bouton = vue.identifiants(d, { siren: '999991011', sonde: null });
  assert.match(bouton, /Essayer les suffixes connus/);
  assert.match(bouton, /une absence ne prouve rien/);
  const vide = vue.identifiants(d, { siren: '999991011', sonde: { essayes: 34, trouves: [] } });
  assert.match(vide, /34 suffixes essayés, aucun ne répond/);
  assert.doesNotMatch(vide, /Essayer les suffixes connus/);
  const plein = vue.identifiants(d, { siren: '999991011', sonde: { essayes: 34, trouves: [
    { input: '0225:999991011_inqom', groups: [groupe('0225:999991011_inqom', 'Chaintrust')] }] } });
  assert.match(plein, /0225:999991011_inqom/);
  assert.match(plein, /Chaintrust/);
  assert.match(plein, /34 suffixes essayés, 1 trouvé/);
});

test('le tableau des identifiants montre la forme non enregistrée et colore un suffixe servi ailleurs', () => {
  const d = { input: '632012100', groups: [groupe('0225:632012100', 'SAP SE')], failedForms: [],
    forms: [{ id: '0002:632012100', status: 'absent' }, { id: '0225:632012100', status: 'ok' }] };
  const boxes = [
    { input: '0225:632012100_achatpub_403201767', nom: 'L OREAL SA', groups: [groupe('0225:632012100_achatpub_403201767', 'ITESOFT')] },
    { input: '0225:632012100_mandat', nom: "L'OREAL FRANCE", groups: [groupe('0225:632012100_mandat', 'SAP SE')] },
  ];
  const t = vue.identifiants(d, { boxes, siren: '632012100' });
  assert.match(t, /0002:632012100<\/td>\s*<td><span class="sec">non enregistré/);
  assert.doesNotMatch(t, /<th>Type<\/th>/);
  assert.strictEqual((t.match(/class="ailleurs"/g) || []).length, 1);
  assert.match(t, /class="ailleurs" title="[^"]*part chez ITESOFT\.">\s*<strong>ITESOFT<\/strong>/);
  assert.match(t, /L OREAL SA/);
});

test('la page suit toujours le même ordre, les identifiants avant la réception', () => {
  const { resultCards } = require('./render.js');
  const etabs = { siren: '999991003', activeTotal: 2, etablissements: [{ siret: '99999100300008' }], listed: 2, inseeTotal: 2 };
  const forms = [{ id: '0002:999991003', status: 'ok' }, { id: '0225:999991003', status: 'ok' }];
  const ordre = (groups) => {
    const d = { input: '999991003', groups, failedForms: [], absentSchemes: [], forms };
    const r = resultMain(d, { siren: '999991003', boxes: [] }) + resultCards(d, { boxes: [], siren: '999991003' })
      + vue.resultRest(d, { etabs, probed: null, siren: '999991003' });
    return ['Identifiants Peppol', 'adresse de réception', 'Établissements', 'Détail technique', 'Registres officiels', 'Comment ça marche'].map((x) => r.indexOf(x));
  };
  for (const pos of [ordre([groupe('0225:999991003', 'API FIRST')]), ordre([groupe('0002:999991003', 'API FIRST'), groupe('0225:999991003', 'SUPER G')])]) {
    assert.ok(pos.every((x, i) => x >= 0 && (i === 0 || x > pos[i - 1])), String(pos));
  }
  const deux = vue.resultRest({ input: '999991003', groups: [groupe('0002:999991003', 'API FIRST'), groupe('0225:999991003', 'SUPER G')], failedForms: [], forms },
    { etabs: null, siren: '999991003' });
  assert.match(deux, /Détail technique : API FIRST/);
  assert.match(deux, /Détail technique : SUPER G/);
});

test('le nom vient au-dessus du verdict, qui porte la plateforme et la date, et la réception porte le SMP et son contact', () => {
  const { resultCards } = require('./render.js');
  const tiime = groupe('0225:922078522', 'TIIME PDP', { selfHosted: false, smpHost: 'smp-peppol.viaadvalvas.com',
    smpCert: { org: 'Axway', country: 'BE' }, contacts: ['mailto:info@tiime.fr'] });
  const d = { input: '922078522', groups: [tiime], failedForms: [], absentSchemes: [], forms: [{ id: '0225:922078522', status: 'ok' }] };
  const main = resultMain(d, { siren: '922078522', boxes: [] });
  assert.match(main, /class="pill">Joignable<\/span><span class="ou">chez <strong>TIIME PDP<\/strong> depuis le <strong>09\/02\/2026<\/strong>/);
  assert.match(main, /<div class="qui"><span class="who">[^]*<\/div>\s*<div class="verdict"><span class="pill">/);
  const cartes = resultCards(d, { boxes: [], siren: '922078522' });
  assert.match(cartes, /smp-peppol\.viaadvalvas\.com<\/a><br><span class="sec">hébergé par Axway \(BE\)/);
  assert.match(cartes, /<dt>contact technique<\/dt><dd><a href="mailto:info@tiime\.fr">info@tiime\.fr<\/a>/);
  assert.doesNotMatch(vue.resultRest(d, { siren: '922078522' }), /contact technique|hébergé par/);
  const chezSoi = resultCards({ ...d, groups: [groupe('0225:922078522', 'API FIRST')] }, { boxes: [], siren: '922078522' });
  assert.doesNotMatch(chezSoi, /hébergé par/);
});

test('les variantes de format se regroupent sans perdre factures et avoirs', () => {
  const ids = [
    'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:cen.eu:en16931:2017::2.1',
    'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:cen.eu:en16931:2017#compliant#urn:peppol:france:billing:cius:1.0::2.1',
    'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2::CreditNote##urn:cen.eu:en16931:2017::2.1',
    'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100::CrossIndustryInvoice##urn:cen.eu:en16931:2017#conformant#urn:peppol:france:billing:extended:1.0::D22B',
  ];
  const f = vue.formats(ids.map(describeDocType));
  assert.strictEqual((f.match(/class="fmt"/g) || []).length, 2);
  assert.match(f, />UBL <span class="sec">factures et avoirs<\/span>/);
  assert.match(f, /title="[^"]*Facture UBL \(CIUS\)/);
  const seule = vue.formats([describeDocType(ids[2])]);
  assert.match(seule, />UBL <span class="sec">avoirs<\/span>/);
});

test('l\'absence au niveau SIREN ne renvoie pas vers une carte qui peut manquer', () => {
  const d = { input: '953321098', groups: [], failedForms: [], absentSchemes: ['0002', '0225'] };
  assert.doesNotMatch(vue.banners(d, [], null, '953321098'), /carte/);
  const seul = { siren: '953321098', activeTotal: 1, listed: 1, etablissements: [{ siret: '95332109800012', commune: 'BRON' }] };
  const vu = [{ input: '95332109800012', groups: [], failedForms: [] }];
  assert.strictEqual(vue.etabSection(seul, vu, false), '');
  assert.match(vue.etabSection(seul, vu, true), /1 actif, sans enregistrement Peppol propre/);
});

test('l\'absence du Directory est une note annotée, et seulement quand elle se décide', () => {
  const d = { groups: [{ ids: ['0225:1', '0002:1'] }] };
  const absente = vue.annuaire(d, new Set());
  assert.match(absente, /^<p class="note">/);
  assert.match(absente, /sans effet sur la livraison/);
  // L'explication tient dans l'infobulle, mais la phrase visible se suffit sans elle.
  assert.match(absente, /title="[^"]*moteur|title="[^"]*recherche/);
  assert.doesNotMatch(absente, /<div class="card"/);
  // Publiée, il n'y a rien à décider ; absente de Peppol non plus.
  assert.strictEqual(vue.annuaire(d, new Set(['0225:1'])), '');
  assert.strictEqual(vue.annuaire({ groups: [] }, new Set()), '');
  assert.strictEqual(vue.annuaire(d, null), '');
});

test('un nom ou un certificat qui contient du HTML ne sort pas de la page', () => {
  const nom = '</script><img src=x onerror=alert(1)>';
  const titre = require('./render.js').titreOnglet(nom);
  assert.strictEqual((titre.match(/<\/script>/g) || []).length, 1);
  assert.doesNotMatch(titre, /<img/);
  const g = (id, org) => ({ ids: [id], apCert: { org }, smpHost: 's', zoneSilent: [], reliquats: [] });
  const d = { input: '999991029', groups: [g('0002:999991029', 'API FIRST'), g('0225:999991029', nom)], failedForms: [], forms: [] };
  const b = vue.banners(d, []);
  assert.doesNotMatch(b, /<img/);
  assert.match(b, /&lt;img src=x/);
});

test('la date d\'activation la plus récente n\'est jamais présentée comme une date de fin', () => {
  const { resultCards } = require('./render.js');
  const g = groupe('0225:922078522', 'TIIME PDP', { activationFrom: '2026-06-03', activationTo: '2026-09-23' });
  const d = { input: '922078522', groups: [g], failedForms: [], absentSchemes: [], forms: [{ id: '0225:922078522', status: 'ok' }] };
  const page = resultMain(d, { siren: '922078522', boxes: [] }) + resultCards(d, { boxes: [], siren: '922078522' });
  assert.doesNotMatch(page, /jusqu'au/);
  assert.match(page, /depuis le <strong>03\/06\/2026<\/strong>/);
  assert.match(page, /<dt>dernière activation<\/dt><dd>23\/09\/2026/);
  const meme = resultCards({ ...d, groups: [groupe('0225:922078522', 'TIIME PDP')] }, { boxes: [], siren: '922078522' });
  assert.doesNotMatch(meme, /dernière activation/);
});

test('la page ne montre aucune date d\'expiration de fiche, ni dans le verdict ni ailleurs', () => {
  const { resultCards } = require('./render.js');
  const g = groupe('0225:810319517', 'API FIRST', { expirationTo: '2027-06-03', endpointDaysLeft: 10 });
  const d = { input: '810319517', groups: [g], failedForms: [], absentSchemes: [], forms: [{ id: '0225:810319517', status: 'ok' }] };
  const page = resultMain(d, { siren: '810319517', boxes: [] }) + resultCards(d, { boxes: [], siren: '810319517' })
    + vue.resultRest(d, { siren: '810319517' });
  assert.match(page, /class="pill">Joignable</);
  assert.doesNotMatch(page, /expir|2027-06-03|03\/06\/2027|Adresse de livraison valide/i);
});
