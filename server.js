'use strict';
/**
 * Local Peppol lookup server.
 *
 * Everything served here comes from Peppol itself: a DNS lookup in the SML, then unauthenticated
 * HTTP GETs on the SMP that DNS points to. No other source is consulted, and nothing is added on
 * top: the four fields returned are the four the SMP publishes.
 *
 * The SMP walk runs server-side because SMPs serve no CORS header (smp.apifirst.fr answers 200
 * but without Access-Control-Allow-Origin), so a browser cannot fetch them directly.
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');
const { lookup, pool, clearFor, netCount, ZONES, probeEndpoint, participantForms, sirenOf } = require('./peppol.js');
const { saisie } = require('./saisie.js');
const { etablissementsList, etablissementsCounts } = require('./etablissements.js');
const { directoryMatches, directoryPublished } = require('./directory.js');
const { sondeSuffixes } = require('./suffixes.js');
const { entreprise, chercheEntreprises } = require('./entreprise.js');
const { page, head, foot, skeleton, posed, resultMain, resultCards, resultRest, candidats, provenance, esc, titreOnglet,
  lotForm, lotRecap, lotHead, lotRow, lotFoot } = require('./render.js');
const { lignesDe, balaye, csvDe } = require('./lot.js');

const PORT = Number(process.env.PORT) || 4321;
// Loopback by default, so a laptop running it does not serve the office network.
const HOST = process.env.HOST || '127.0.0.1';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const AUTO_PROBE_MAX = 25;
const BUDGET_MS = Number(process.env.BUDGET_MS) || 20000;
const PROBE_MAX = 50;
const BOX_MAX = 8;
const SIDE_MS = 5000;
// The Peppol Directory's full-text search answers a SIREN it has never been asked about in about
// five seconds, then in under one. It is only used to look for suffixed identifiers, which are a
// bonus below a card that already says the company is reachable, so the page stops waiting for it.
const DIR_MS = 1200;

// A side source is an accompaniment, never the answer: past its own deadline the page goes out
// without it rather than making everyone wait for a register that is having a bad day.
const side = (p, ms = SIDE_MS) =>
  Promise.race([Promise.resolve(p).catch(() => null), new Promise((r) => setTimeout(r, ms, null))]);

const MAX_CORPS = 256 * 1024;
// Le dernier lot reste en mémoire le temps du téléchargement : le relancer coûterait tous les appels.
const lots = new Map();

// Au-delà du plafond on cesse d'accumuler sans couper la connexion, sinon le navigateur
// n'affiche qu'une erreur réseau là où il faut une phrase.
function corps(req) {
  return new Promise((resolve, reject) => {
    let b = '', n = 0, trop = false;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_CORPS) { trop = true; return; }
      b += c;
    });
    req.on('end', () => resolve({ f: new URLSearchParams(b), trop }));
    req.on('error', reject);
  });
}

async function lotPost(req, res) {
  let recu;
  try { recu = await corps(req); }
  catch { return html(res, page(lotForm('', 'La liste n\'est pas arrivée en entier. Réessayer.'), '')); }
  const { f, trop } = recu;
  if (trop) return html(res, page(lotForm('', `La liste dépasse ${MAX_CORPS / 1024} ko. La couper en plusieurs lots.`), ''));
  const texte = f.get('texte') || '';
  const lu = lignesDe(texte);
  if (!f.get('go') || !lu.lignes.length) return html(res, page(lotRecap(lu, texte), ''));

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.write(head('') + lotHead(lu.lignes.length));
  const rows = [];
  const resume = await balaye(lu.lignes, { complet: !!f.get('complet'), annuaire: !!f.get('annuaire') },
    (r) => { rows.push(r); res.write(lotRow(r)); });
  const jeton = Date.now().toString(36);
  lots.set(jeton, rows);
  for (const k of [...lots.keys()].slice(0, -3)) lots.delete(k);
  res.end(lotFoot(resume, jeton) + foot());
}

const html = (res, body) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};

/**
 * The page itself, rendered server side. A plain GET form drives it, so it works with no script
 * in the browser at all.
 */
async function pageFor(res, u) {
  const q = u.searchParams.get('q');
  const { ident, nom, erreur } = saisie(q);
  // A name is not a Peppol search: it is resolved against the state register first, and the
  // SIREN it yields is what gets probed. Costs one HTTP call and no Peppol traffic at all.
  if (nom) {
    const found = await side(chercheEntreprises(nom, 10), 4000);
    return html(res, page(candidats(nom, found), q));
  }
  if (!ident) return html(res, page(erreur ? `<div class="err">${esc(erreur)}</div>` : '', q));
  const t0 = Date.now();
  const net0 = netCount();

  // The Peppol walk and the establishment list are independent, so they run together: doing them
  // in sequence made the page wait for the sum of two things that never needed each other.
  // Establishments only make sense for a SIREN, a SIRET already being at that level.
  const isSiren = ident.length === 9;

  // Three independent chains, started together. The SIRET probe only needs the list, never the
  // counts, so it no longer waits for them: that was a few hundred milliseconds on every cold page.
  const siren = sirenOf(ident);
  const lookupP = lookup(ident).then((r) => ({ ...r, ms: 0 }));
  const entP = siren ? side(entreprise(siren), 4000) : Promise.resolve(null);
  const dirFull = siren ? Promise.resolve(directoryMatches(siren)).catch(() => null) : Promise.resolve(null);
  // Whether the participant is published is asked by key, on the identifiers that answered: about
  // 100 ms, and an answer rather than a race. The full-text search above cannot do that in time.
  const pubP = side(lookupP.then((r) => {
    const ids = [...new Set(r.groups.flatMap((g) => g.ids))];
    return ids.length ? directoryPublished(ids) : null;
  }), 2000);
  // The Directory only hands us identifiers; each one is then resolved live like any other, so a
  // suffixed box is measured, not quoted. They are few in practice, and they resolve in parallel.
  // A SIRET that answers nothing says nothing about its SIREN, which is usually where the company
  // is actually reachable. Resolved only in that case, so a registered SIRET pays nothing for it.
  const sirenP = !isSiren && siren
    ? lookupP.then((r) => (r.groups.length ? null : lookup(siren).catch(() => null)))
    : Promise.resolve(null);

  const boxesP = dirFull.then((dir) => {
    if (!dir) return null;
    // The SIREN's own standard forms are not suffixed boxes, whatever was typed in the box.
    const known = new Set([...participantForms(ident), ...(siren ? participantForms(siren) : [])]);
    const extra = dir.listed.filter((m) => !known.has(m.id)).slice(0, BOX_MAX);
    if (!extra.length) return [];
    return pool(extra, 4, (m) => lookup(m.id, { diagnose: false }).then((r) => ({ ...r, nom: m.nom })).catch(() => null));
  }).catch(() => null);
  // Two deadlines for the same thing: a verdict of "absent" would be wrong if a suffixed box
  // answers, so that one waits for the Directory however long it takes. Below a card that already
  // says the company is reachable, the boxes are an extra, and an extra does not hold the page.
  const boxesBrief = side(boxesP, DIR_MS);
  // Sur demande seulement : trente requêtes DNS pour une devinette ne se font pas à chaque page.
  const sondeP = u.searchParams.get('suffixes') && siren
    ? side(lookupP.then((r) => sondeSuffixes(siren, [...r.groups.flatMap((g) => g.ids), ...participantForms(siren)])), 15000)
    : Promise.resolve(null);
  const listP = isSiren ? etablissementsList(ident, 200).catch(() => null) : Promise.resolve(null);
  const countsP = isSiren ? side(etablissementsCounts(ident), 6000) : Promise.resolve(null);
  const probedP = listP.then((list) => {
    if (!list || !list.etablissements.length) return null;
    const wanted = u.searchParams.get('etabs') || list.etablissements.length <= AUTO_PROBE_MAX;
    if (!wanted) return null;
    // Listing is cheap, probing is not: each SIRET costs two SML lookups per zone plus the SMP
    // walk, so the probe has its own, lower ceiling.
    return pool(list.etablissements.slice(0, PROBE_MAX).map((x) => x.siret), 6, (i) => lookup(i, { diagnose: false }));
  });

  // Written straight away: the browser can lay out the header and fetch the stylesheet while the
  // registers are still answering, instead of holding a blank window until the slowest one does.
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.write(head(ident) + skeleton());
  // Le nom arrive après l'en-tête, déjà parti : le titre d'onglet se corrige donc en chemin.
  const head2 = (ent) => (ent && ent.nom ? titreOnglet(ent.nom) : '');

  const late = (e) => res.end(posed('a') + posed('b') + posed('c') + `<div class="err">${esc(e)}</div>` + foot());
  const budget = (p) => Promise.race([p,
    new Promise((_, rej) => setTimeout(rej, BUDGET_MS, new Error('budget')))]);
  let d, redirige;
  try {
    const [lk, ent, parent] = await budget(Promise.all([lookupP, entP, sirenP]));
    d = lk;
    // Opt-in only: this calls another operator's gateway, so it never happens on a plain page view.
    if (u.searchParams.get('probe')) {
      const urls = [...new Set(d.groups.flatMap((g) => g.endpoints))];
      const results = Object.fromEntries((await pool(urls, 4, probeEndpoint)).map((r) => [r.url, r]));
      for (const g of d.groups) g.probes = g.endpoints.map((e) => results[e]).filter(Boolean);
    }
    // "Absent from Peppol" is false if a suffixed box answers, so that verdict, and only that
    // one, waits for the boxes. A participant whose standard forms resolve never pays for this.
    const boxesEarly = d.groups.length ? null : await budget(boxesP);
    // Nothing answers under the identifier that was typed, but something answers elsewhere: the
    // page is then a signpost, and everything below the banner belongs to the page it points at.
    redirige = !d.groups.length
      && !!((parent && parent.groups.length) || (boxesEarly || []).some((b) => b && b.groups.length));
    d.ms = Date.now() - t0;
    res.write(posed('a') + head2(ent) + resultMain(d, { ent, parent, siren, boxes: (boxesEarly || []).filter(Boolean) }));
  } catch {
    return late(`La résolution a dépassé ${BUDGET_MS / 1000} s. Un serveur interrogé ne répond pas. Réessayer, ou rejouer sans cache.`);
  }

  // The identifiers lead the cards and include the SIRET forms, so the cards wait for the Directory and the establishment probe, each on a leash.
  const [boxes, sonde, list, probed] = await Promise.all([boxesBrief, sondeP, listP, side(probedP, BUDGET_MS)]);
  res.write(posed('b') + resultCards(d, { boxes: (boxes || []).filter(Boolean), siren, sonde, redirige, etabs: list, probed }));

  try {
    const [counts, publies] = await budget(Promise.all([countsP, pubP]));
    const etabs = list && { ...list, ...counts, truncated: list.etablissements.length < list.activeTotal,
      probeLimited: list.etablissements.length > PROBE_MAX ? PROBE_MAX : null };
    res.write(posed('c') + resultRest(d, { etabs, probed, siren, redirige, publies }));
  } catch {
    let reste = '';
    try { reste = resultRest(d, { siren, redirige }); } catch { /* the banner alone still reads */ }
    res.write(posed('c') + '<div class="banner b-warn">Les établissements n\'ont pas pu être listés dans le temps imparti.</div>' + reste);
  }
  res.end(provenance(d, netCount() > net0) + foot());
}


const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};






async function apiLookup(res, q) {
  const { ident, erreur } = saisie(q);
  if (!ident) return json(res, 400, { error: erreur || 'attendu : un SIREN (9 chiffres), un SIRET (14 chiffres), ou un identifiant Peppol complet' });
  const t0 = Date.now();
  const body = JSON.stringify({ ...(await lookup(ident)), zones: ZONES, ms: Date.now() - t0 }, null, 1);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}



http
  .createServer(async (req, res) => {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    try {
      if (u.searchParams.get('fresh')) {
        const { ident } = saisie(u.searchParams.get('q') || decodeURIComponent(u.pathname.slice(1)));
        if (ident) clearFor(ident, sirenOf(ident));
      }
      if (u.pathname === '/lot' && req.method === 'POST') return await lotPost(req, res);
      if (u.pathname === '/lot') return html(res, page(lotForm(''), ''));
      if (u.pathname === '/lot.csv') {
        const rows = lots.get(u.searchParams.get('t') || '');
        if (!rows) { res.writeHead(404).end('lot expiré, relancer la liste'); return; }
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="peppolsonar.csv"' });
        res.end(csvDe(rows));
        return;
      }
      if (u.pathname === '/api/lookup') return await apiLookup(res, u.searchParams.get('q'));
      if (u.pathname === '/') return await pageFor(res, u);
      // Clean URL: /810319517 and /0225:810319517 behave like ?q=, so a result can be shared as a path.
      const asPath = decodeURIComponent(u.pathname.slice(1));
      if (saisie(asPath).ident) {
        u.searchParams.set('q', asPath);
        return await pageFor(res, u);
      }
      const file = path.join(__dirname, 'public', u.pathname.replace(/^\/+/, ''));
      if (!file.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403).end(); return; }
      const body = fs.readFileSync(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch (e) {
      if (e.code === 'ENOENT') { res.writeHead(404).end('not found'); return; }
      json(res, 500, { error: String(e.message || e) });
    }
  })
  .listen(PORT, HOST, () => {
    console.log(`PeppolSonar -> http://localhost:${PORT} (écoute sur ${HOST})`);
    console.log(`  SML : ${ZONES.join(' + ')}`);
  });
