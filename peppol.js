'use strict';
/**
 * Peppol discovery core: SIREN/SIRET -> participant forms -> SMP -> AS4 + AP certificate.
 *
 * Port of ~/Desktop/peppol-discovery-toolkit/resolve_peppol_hosts.py, plus the AP certificate
 * subject (the only reliable way to name the PA behind a multi-tenant host such as Axway's
 * gw-paNN.einvoicing.axwaycloud.com), dual-SML resolution and an evidence trail.
 *
 * Discovery: we read hosts and certificate subjects, and we check each certificate was issued by
 * the pinned Peppol CA (pki.js). We do NOT verify the XML signature over the response, nor the
 * TLS chain. The real AS4 send does full trust verification.
 */
const crypto = require('node:crypto');
const https = require('node:https');
const { URL } = require('node:url');
const { verifyIssuer } = require('./pki.js');

/**
 * La première zone fait foi, les suivantes sont lues mais ne décident de rien.
 *
 * Depuis la reprise du SML par OpenPeppol, la zone Peppol est primaire et la zone historique de la
 * Commission n'est plus répliquée (phase T5 de leur plan, activités finales le 02/09/2026, puis
 * extinction à la discrétion de la Commission). Mesuré depuis : une inscription du 23/09 jamais
 * reprise, une du 09/10 reprise, une suppression jamais appliquée. On la lit donc pour dire ce
 * qu'elle traîne encore, jamais pour décider si un participant est joignable.
 */
const ZONES = (process.env.SML_ZONES || 'participant.sml.prod.tech.peppol.org,edelivery.tech.ec.europa.eu')
  .split(',').map((z) => z.trim()).filter(Boolean);

const SCHEME = 'iso6523-actorid-upis';
const TIMEOUT = 15000;
const CACHE_TTL = Number(process.env.CACHE_TTL_MS) || 10 * 60 * 1000;
// L'outil s'annonce : mesuré sur six SMP et les cinq sources publiques, aucun ne traite ce nom autrement qu'un navigateur.
const UA = 'PeppolSonar/1.0 (verification de joignabilite Peppol)';

/**
 * Two resolvers, tried in order. Cloudflare alone was a single point of failure for the whole
 * tool: no DNS, no lookup, whatever the SMP is doing.
 */
const RESOLVERS = (process.env.DOH_RESOLVERS ||
  'https://cloudflare-dns.com/dns-query,https://dns.google/resolve').split(',').map((r) => r.trim());

/**
 * One connection per host, reused. Reading an SMP record is a ServiceGroup GET followed by one GET
 * per document type on that same host, and each of them was paying its own TLS handshake.
 */
const agent = new https.Agent({ keepAlive: true, maxSockets: 12, timeout: TIMEOUT });

const cache = new Map();
// A source that is down used to cost its full timeout on every single page: the failure was
// dropped from the cache, so the next reader paid for it again. It is now remembered too, for a
// fraction of the time a success is, which is long enough to spare a page and short enough to
// notice the source coming back.
const FAIL_TTL = 60 * 1000;
function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = fn();
  cache.set(key, { value, expires: Date.now() + CACHE_TTL });
  value.catch(() => cache.set(key, { value, expires: Date.now() + FAIL_TTL }));
  return value;
}
const clearCache = () => cache.clear();

/**
 * Vider le cache d'UN identifiant, pas celui de tout le monde.
 *
 * `fresh=1` appelait `cache.clear()` : rejouer une fiche faisait repartir de zéro toutes les
 * autres, pour tous les visiteurs. Les clés portent l'URL, donc le nom DNS de chaque forme et le
 * SIREN suffisent à retrouver les siennes.
 */
function clearFor(ident, siren) {
  const marques = [ident, siren].filter(Boolean).map(encodeURIComponent);
  for (const pid of participantForms(ident)) {
    marques.push(encodeURIComponent(pid));
    for (const z of ZONES) marques.push(dnsName(pid, z));
  }
  let n = 0;
  for (const k of cache.keys()) if (marques.some((m) => k.includes(m))) { cache.delete(k); n++; }
  return n;
}

// Un compteur d'appels réellement partis sur le réseau, pour ne pas présenter une réponse servie
// depuis le cache comme une mesure fraîche.
let fetches = 0;
const netCount = () => fetches;

function rawGet(url, headers = {}, timeout = TIMEOUT) {
  fetches++;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET',
        headers: { 'User-Agent': UA, Accept: 'application/xml, application/json, */*', ...headers },
        agent, rejectUnauthorized: false, timeout,
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return resolve(rawGet(new URL(res.headers.location, url).href, headers, timeout));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
const get = (url, headers, timeout) => cached(`GET ${url}`, () => rawGet(url, headers, timeout));

/** Run promise-returning tasks with a cap, so a batch does not open hundreds of sockets. */
async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await worker(items[i], i);
      }
    })
  );
  return out;
}

/**
 * What to probe for a given input.
 *
 * A SIREN or a SIRET is expanded into the identifier forms our own registration posts.
 * Anything already shaped as a Peppol identifier is probed as is,
 * which is the only way to reach the rest of the addressing space: foreign organisation numbers,
 * VAT-based schemes, GLN. Peppol addressing is not limited to the three French schemes.
 */
const PEPPOL_ID = /^\d{4}:[A-Za-z0-9._\-+/:]{1,60}$/;

const SUFFIXED = /^\d{9}_[A-Za-z0-9._\-+/]{1,50}$/;

function participantForms(ident) {
  if (PEPPOL_ID.test(ident)) return [ident];
  if (/^\d{9}$/.test(ident)) return [`0002:${ident}`, `0225:${ident}`];
  if (/^\d{14}$/.test(ident)) return [`0009:${ident}`, `0225:${ident.slice(0, 9)}_${ident}`];
  // A suffixed mailbox pasted without its scheme: the suffix convention is 0225 only.
  if (SUFFIXED.test(ident)) return [`0225:${ident}`];
  return [];
}

/**
 * The SIREN inside an identifier, whatever shape it arrived in.
 *
 * Needed by everything that is not Peppol: the company name, the Directory query, the register
 * links. Foreign schemes return null rather than a nine-digit slice that means nothing here.
 */
function sirenOf(ident) {
  const peppol = PEPPOL_ID.test(ident);
  if (peppol && !['0002', '0009', '0225'].includes(ident.slice(0, 4))) return null;
  const v = peppol ? ident.slice(5) : ident;
  const m = /^(\d{9})(?:_|$)/.exec(v) || /^(\d{9})\d{5}$/.exec(v);
  return m ? m[1] : null;
}

function base32(buf) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}

/** Peppol hashes the identifier VALUE ("0225:123456789"); the scheme is a separate DNS label. */
function dnsName(pid, zone) {
  const label = base32(crypto.createHash('sha256').update(pid.toLowerCase()).digest()).toLowerCase();
  return `${label}.${SCHEME}.${zone}`;
}

async function naptr(pid, zone, resolvers = RESOLVERS) {
  const name = dnsName(pid, zone);
  // A resolver hiccup must degrade this one zone to "silent", not blow up the whole lookup:
  // the zones run in a Promise.all, so a throw here used to take the page down with it.
  let json, lastError = null;
  for (const resolver of resolvers) {
    try {
      const res = await get(`${resolver}?name=${encodeURIComponent(name)}&type=NAPTR`, { Accept: 'application/dns-json' });
      json = JSON.parse(res.body);
      break;
    } catch (e) { lastError = String(e.message || e); }
  }
  // No resolver answered at all: the zone is silent, which is not the same as a zone that answers
  // it does not hold this participant. Only the first is a failed measurement.
  if (!json) return { zone, name, url: null, raw: null, ttl: null, ad: null, error: lastError, dnsStatus: null };
  for (const a of json.Answer || []) {
    const m = /(https?:\/\/[^\s"'!]+)/.exec(a.data || '');
    if (m) return { zone, name, url: m[1].replace(/\/$/, ''), raw: a.data, ttl: a.TTL, ad: json.AD, dnsStatus: json.Status ?? 0 };
  }
  return { zone, name, url: null, raw: null, ttl: null, ad: json.AD, dnsStatus: json.Status ?? 0 };
}

// Un seul NAPTR sur la zone qui décide : de quoi écarter un candidat sans toucher à aucun SMP.
const resoutDansSml = async (pid) => !!(await naptr(pid, ZONES[0])).url;

const unescapeXml = (s) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

const allTags = (xml, tag) =>
  [...xml.matchAll(new RegExp(`<(?:[\\w.-]+:)?${tag}[^>]*>([^<]*)<`, 'g'))].map((m) => unescapeXml(m[1].trim())).filter(Boolean);

const allAttrs = (xml, attr) =>
  [...xml.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))].map((m) => unescapeXml(m[1].trim()));

/** Decode one base64 DER certificate into the fields worth showing. */
function parseCert(b64) {
  try {
    const c = new crypto.X509Certificate(Buffer.from(b64.replace(/&#13;/g, '').replace(/\s+/g, ''), 'base64'));
    const f = Object.fromEntries(
      c.subject.split('\n').map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; })
    );
    return {
      subject: c.subject.replace(/\n/g, ', '),
      org: f.O || null, country: f.C || null, ou: f.OU || null, cn: f.CN || null,
      issuer: (/CN=([^\n]+)/.exec(c.issuer) || [])[1] || null,
      validFrom: c.validFrom, validTo: c.validTo,
      daysLeft: Math.round((new Date(c.validTo) - Date.now()) / 86400000),
      serial: c.serialNumber, fingerprint: c.fingerprint256,
      // Whether OpenPeppol actually issued it, which is what makes the subject name worth reading.
      issue: verifyIssuer(c),
    };
  } catch { return null; }
}

// <smp:Certificate> is the ACCESS POINT certificate; <ds:X509Certificate> under <Signature> is the
// certificate the SMP signed the response with. They are often different organisations: Tiime runs
// its own access point but its SMP is hosted and signed by Axway.
function apCert(xml) {
  const m = /<(?:[\w.-]+:)?Certificate>([\s\S]*?)<\//.exec(xml);
  return m ? parseCert(m[1]) : null;
}
function smpCert(xml) {
  const m = /<(?:[\w.-]+:)?X509Certificate>([\s\S]*?)<\//.exec(xml);
  return m ? parseCert(m[1]) : null;
}

/** Peppol document identifier -> what the participant can actually receive. */
function describeDocType(id) {
  const s = id.toLowerCase();
  const syntax =
    s.includes('pdf+xml') ? 'Factur-X'
    : s.includes('crossdomainacknowledgement') ? 'Statuts de cycle de vie'
    : s.includes('crossindustryinvoice') ? 'CII'
    : s.includes('creditnote') ? 'Avoir UBL'
    : s.includes(':invoice-2::invoice') ? 'Facture UBL'
    : id.split('##')[0].split('::').pop();
  const profile = s.includes(':extended:') ? 'étendu' : s.includes(':cius:') ? 'CIUS' : s.includes(':cdv:') ? 'CDV' : null;
  const version = (/::([\w.]+)$/.exec(id) || [])[1] || null;
  return { id, syntax, profile, version, label: profile && profile !== 'CDV' ? `${syntax} (${profile})` : syntax };
}

/**
 * When a participant's record cannot be read, is the SMP itself down?
 *
 * The distinction is the whole message: a host-wide outage makes every participant it serves
 * unreachable, while a server that answers on its root and not on one record is a different
 * problem. Measured rather than inferred, on a short leash because the failing call already cost
 * ten seconds. Any HTTP answer counts as alive: 404 on the root is a normal SMP.
 */
async function smpAlive(smpUrl) {
  const root = new URL(smpUrl).origin + '/';
  try { return { alive: true, status: (await get(root, {}, 2500)).status }; }
  catch (e) { return { alive: false, status: null, error: String(e.message || e) }; }
}

async function resolveForm(pid, { diagnose, shallow, headers, zones: wanted } = {}) {
  const zones = await Promise.all((wanted || ZONES).map((z) => naptr(pid, z)));

  // Un résolveur muet n'est pas une absence : la zone qui décide est reposée à l'autre résolveur.
  if (!zones[0].url && zones[0].dnsStatus == null) {
    zones[0] = await naptr(pid, zones[0].zone, [...RESOLVERS].reverse());
  }
  const principale = zones[0];
  const out = {
    id: pid, scheme: pid.split(':')[0],
    status: principale.url ? 'ok' : 'absent',
    zones: zones.map((z) => ({ zone: z.zone, dnsName: z.name, naptr: z.raw || null, ttl: z.ttl ?? null, dnssec: z.ad ?? null, dnsStatus: z.dnsStatus ?? null, resolverError: z.error || null, smp: z.url ? new URL(z.url).hostname : null })),
    // Aucune réponse du tout de la zone qui décide : mesure ratée, à distinguer d'une absence.
    zoneSilent: !principale.url && principale.dnsStatus == null ? [principale.zone] : [],
    // Ce que les zones en retrait portent encore et que la zone primaire ne dit pas.
    reliquats: zones.slice(1).filter((z) => z.url && z.url !== principale.url)
      .map((z) => ({ zone: z.zone, smp: new URL(z.url).hostname })),
    smpHost: null, endpoints: [], transportProfiles: [], processIds: [],
    activationDates: [], expirationDates: [], docTypes: [],
    apCert: null, smpCert: null, contacts: [], infoUrls: [],
    failedDocTypes: [], evidence: null, error: null,
  };
  if (!principale.url) return out;

  const smpUrl = principale.url;
  out.smpHost = new URL(smpUrl).hostname;
  const sgUrl = `${smpUrl}/${encodeURIComponent(`${SCHEME}::${pid}`)}`;
  let sg;
  try {
    sg = await get(sgUrl, headers);
    if (sg.status !== 200) throw new Error(`ServiceGroup HTTP ${sg.status}`);
  } catch (e) {
    out.status = 'error';
    out.error = String(e.message || e);
    out.errorStatus = sg ? sg.status : null;
    if (diagnose) out.smpAlive = await smpAlive(smpUrl);
    out.evidence = { serviceGroupUrl: sgUrl, serviceMetadataUrls: [] };
    return out;
  }

  const refs = [...sg.body.matchAll(/ServiceMetadataReference[^>]*href="([^"]+)"/g)].map((m) => unescapeXml(m[1]));
  out.evidence = { serviceGroupUrl: sgUrl, serviceMetadataUrls: refs };
  const endpoints = new Set(), profiles = new Set(), processes = new Set();
  const act = new Set(), exp = new Set(), contacts = new Set(), infos = new Set(), descs = new Set();

  // Shallow: every page of a record carries the access point certificate, the delivery address and
  // the validity window. Only the document type list needs them all, and a sweep does not ask that.
  out.docTypeCount = refs.length;
  const pages = await pool(shallow ? refs.slice(0, 1) : refs, 6, async (href) => {
    try {
      const sm = await get(href, headers);
      return { href, status: sm.status, body: sm.status === 200 ? sm.body : null };
    } catch (e) { return { href, status: null, body: null, error: String(e.message || e) }; }
  });

  for (const page of pages) {
    const doc = decodeURIComponent(page.href.split('/services/')[1] || page.href).replace(/^busdox-docid-qns::/, '');
    if (!page.body) { out.failedDocTypes.push({ doc, status: page.status, error: page.error || null }); continue; }
    out.docTypes.push(describeDocType(doc));
    // Keep the full delivery URL, not just the host: the path is part of where the AS4 message goes.
    for (const u of [...allTags(page.body, 'EndpointURI'), ...allTags(page.body, 'Address')]) {
      if (u.startsWith('http')) endpoints.add(u);
    }
    for (const p of allAttrs(page.body, 'transportProfile')) profiles.add(p);
    for (const p of allTags(page.body, 'ProcessIdentifier')) processes.add(p);
    for (const d of [...allTags(page.body, 'ServiceActivationDate'), ...allTags(page.body, 'ActivationDate')]) act.add(d);
    for (const d of allTags(page.body, 'ServiceExpirationDate')) exp.add(d);
    for (const c of allTags(page.body, 'TechnicalContactUrl')) contacts.add(c);
    for (const c of allTags(page.body, 'TechnicalInformationUrl')) infos.add(c);
    for (const c of allTags(page.body, 'ServiceDescription')) descs.add(c);
    if (!out.apCert) out.apCert = apCert(page.body);
    if (!out.smpCert) out.smpCert = smpCert(page.body);
  }

  out.endpoints = [...endpoints].sort();
  out.transportProfiles = [...profiles].sort();
  out.processIds = [...processes].sort();
  out.activationDates = [...act].sort();
  out.expirationDates = [...exp].sort();
  out.contacts = [...contacts].sort();
  out.infoUrls = [...infos].sort();
  out.descriptions = [...descs].sort();
  if (!refs.length) {
    // The SMP answers for this participant but its ServiceMetadataReferenceCollection is empty:
    // registered, yet declaring nothing. A sender resolving it finds the server and no service.
    out.status = 'error';
    out.error = 'aucun service publié : le SMP connaît ce participant mais ne déclare aucun type de document';
  } else if (!out.endpoints.length) {
    out.status = 'error';
    out.error = 'types de documents déclarés, mais aucune adresse de livraison lisible';
  }
  return out;
}

/**
 * Collapse the participant forms of one identifier into what is actually distinct.
 *
 * A SIREN is registered under two forms (0002 and 0225) that normally carry the SAME endpoint and
 * certificate, so showing them twice says nothing. Grouping by (access point, endpoint, SMP) keeps
 * one block in that case, and splits only when the forms genuinely disagree -- which is the finding
 * worth seeing: a SIREN whose 0002 is with us and whose 0225 has moved to another platform.
 */
function mergeForms(forms) {
  const live = forms.filter((f) => f.status === 'ok');
  const groups = [];
  for (const f of live) {
    const key = [f.apCert && f.apCert.cn, f.smpHost, f.endpoints.join('|')].join('~');
    let g = groups.find((x) => x.key === key);
    if (!g) {
      groups.push((g = {
        key, ids: [], schemes: [], smpHost: f.smpHost,
        endpoints: [...f.endpoints], transportProfiles: [...f.transportProfiles], processIds: [...f.processIds],
        apCert: f.apCert, smpCert: f.smpCert,
        docTypes: [], docTypeCount: 0, activationFrom: null, activationTo: null,
        contacts: [...f.contacts], infoUrls: [...f.infoUrls], descriptions: [...f.descriptions],
        zones: f.zones, zoneSilent: [...f.zoneSilent], reliquats: [...(f.reliquats || [])], failedDocTypes: [...f.failedDocTypes],
        evidence: [f.evidence].filter(Boolean),
      }));
    } else {
      g.evidence.push(f.evidence);
      for (const c of f.contacts) if (!g.contacts.includes(c)) g.contacts.push(c);
      for (const c of f.infoUrls) if (!g.infoUrls.includes(c)) g.infoUrls.push(c);
      for (const c of f.descriptions) if (!g.descriptions.includes(c)) g.descriptions.push(c);
      g.failedDocTypes.push(...f.failedDocTypes);
      for (const z of f.zoneSilent) if (!g.zoneSilent.includes(z)) g.zoneSilent.push(z);
      for (const r of f.reliquats || []) if (!g.reliquats.some((x) => x.zone === r.zone && x.smp === r.smp)) g.reliquats.push(r);
    }
    g.ids.push(f.id);
    g.schemes.push(f.scheme);
    for (const d of f.docTypes) if (!g.docTypes.some((x) => x.id === d.id)) g.docTypes.push(d);
    g.docTypeCount = Math.max(g.docTypeCount, f.docTypeCount || f.docTypes.length);
    const a = f.activationDates;
    if (a.length) {
      g.activationFrom = g.activationFrom && g.activationFrom < a[0] ? g.activationFrom : a[0];
      g.activationTo = g.activationTo && g.activationTo > a[a.length - 1] ? g.activationTo : a[a.length - 1];
    }
  }
  for (const g of groups) {
    g.ids.sort();
    g.schemes.sort();
    g.docTypes.sort((x, y) => x.label.localeCompare(y.label));
    // Running your own SMP or being hosted by someone else is visible without any external source.
    g.selfHosted = !!(g.apCert && g.smpCert && g.apCert.org === g.smpCert.org);
    // Each document type expires on its own date, so no single record expiry is kept; per form they stay in expirationDates.
    g.certDaysLeft = g.apCert ? g.apCert.daysLeft : null;
  }
  return {
    groups,
    absentSchemes: forms.filter((f) => f.status === 'absent').map((f) => f.scheme),
    failedForms: forms.filter((f) => f.status === 'error')
      .map((f) => ({ id: f.id, scheme: f.scheme, smpHost: f.smpHost, error: f.error,
        errorStatus: f.errorStatus ?? null, smpAlive: f.smpAlive ?? null })),
  };
}

/**
 * `diagnose` decides whether a form that fails is investigated further (is the SMP itself down).
 * That question costs up to 2.5 s and is only ever displayed for the identifier that was typed, so
 * the establishment sweep, which resolves dozens of SIRETs to name a platform, switches it off.
 * `shallow` reads one page of the record instead of all of them, `zones` narrows the SML lookup,
 * and `headers` lets a sweep announce itself rather than borrow the page's browser user agent.
 */
async function lookup(ident, opts = {}) {
  const forms = participantForms(ident);
  if (!forms.length) throw new Error('attendu : un SIREN (9 chiffres), un SIRET (14 chiffres), ou un identifiant Peppol complet');
  const resolved = await Promise.all(forms.map((f) => resolveForm(f, { diagnose: true, ...opts })));
  return { input: ident, forms: resolved, ...mergeForms(resolved) };
}



/**
 * Is the published AS4 endpoint actually answering? Opt-in, never automatic: this hits another
 * operator's gateway, and a tool that pings every competitor on every page view is impolite.
 * Any HTTP answer counts as reachable -- an AS4 gateway is expected to reject a bare GET.
 */
async function probeEndpoint(url) {
  const t0 = Date.now();
  try {
    const r = await rawGet(url);
    return { url, reachable: true, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return { url, reachable: false, status: null, ms: Date.now() - t0, error: String(e.message || e) };
  }
}

module.exports = {
  lookup, PEPPOL_ID, get, pool, clearCache, clearFor, netCount, ZONES, probeEndpoint, RESOLVERS, resoutDansSml,
  participantForms, sirenOf,
  // Exposed for the tests only: pinning these is what catches a silent drift.
  __test: { dnsName, participantForms, sirenOf, describeDocType, apCert, smpCert, allTags, mergeForms },
};