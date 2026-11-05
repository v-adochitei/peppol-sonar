'use strict';
/**
 * HTML rendering, server side. The page carries no script of its own: a plain GET form drives it,
 * <details> opens the technical panel natively, and the logo animation is CSS. What used to be
 * 186 lines of browser JavaScript is this file, which also removes the second place where the
 * same markup was built.
 */

const { MAX_LIGNES } = require('./lot.js');
const { ZONES } = require('./peppol.js');
const ZONES_LABEL = ZONES[0];
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const day = (s) => (s || "").slice(0, 10);
const fr = (s) => { const d = day(s); const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d); return m ? `${m[3]}/${m[2]}/${m[1]}` : d; };

const LOGO = "<svg class=\"logo\" viewBox=\"0 0 32 32\" fill=\"none\" aria-hidden=\"true\"><circle cx=\"6\" cy=\"16\" r=\"2.6\" fill=\"currentColor\"/><path d=\"M10.31 10.48A7 7 0 0 1 10.31 21.52\" stroke=\"currentColor\" class=\"ping ping1\" stroke-width=\"2.1\" stroke-linecap=\"round\"/><path d=\"M13.39 6.54A12 12 0 0 1 13.39 25.46\" stroke=\"currentColor\" class=\"ping ping2\" stroke-width=\"1.9\" stroke-linecap=\"round\" opacity=\".7\"/><path d=\"M16.47 2.60A17 17 0 0 1 16.47 29.40\" stroke=\"currentColor\" class=\"ping ping3\" stroke-width=\"1.7\" stroke-linecap=\"round\" opacity=\".45\"/><circle class=\"blip\" cx=\"27.5\" cy=\"16\" r=\"2.4\" fill=\"currentColor\"/></svg>";
const FAVICON = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%20fill%3D%22none%22%3E%3Ccircle%20cx%3D%226%22%20cy%3D%2216%22%20r%3D%222.6%22%20fill%3D%22%231447ff%22%2F%3E%3Cpath%20d%3D%22M10.31%2010.48A7%207%200%200%201%2010.31%2021.52%22%20stroke%3D%22%231447ff%22%20stroke-width%3D%222.1%22%20stroke-linecap%3D%22round%22%2F%3E%3Cpath%20d%3D%22M13.39%206.54A12%2012%200%200%201%2013.39%2025.46%22%20stroke%3D%22%231447ff%22%20stroke-width%3D%221.9%22%20stroke-linecap%3D%22round%22%20opacity%3D%22.7%22%2F%3E%3Cpath%20d%3D%22M16.47%202.60A17%2017%200%200%201%2016.47%2029.40%22%20stroke%3D%22%231447ff%22%20stroke-width%3D%221.7%22%20stroke-linecap%3D%22round%22%20opacity%3D%22.45%22%2F%3E%3Ccircle%20cx%3D%2227.5%22%20cy%3D%2216%22%20r%3D%222.4%22%20fill%3D%22%23ff3d71%22%2F%3E%3C%2Fsvg%3E";

const SCHEME_LABEL = {
  "0002": "SIREN, schéma historique",
  "0009": "SIRET, schéma historique",
  "0225": "schéma FR-CTC du cadre PPF",
};
const idTag = (id) => `<span class="tag on" title="${esc(SCHEME_LABEL[id.split(":")[0]] || "")}">${esc(id)}</span>`;

/** Official registers, so "who is this company" gets an answer without us pretending to know. */
function registres(siren) {
  const l = [
    ['Annuaire des Entreprises', `https://annuaire-entreprises.data.gouv.fr/entreprise/${siren}`,
     'Fiche officielle : dénomination, activité, statut, établissements.', 'DINUM'],
    ['Registre National des Entreprises', `https://data.inpi.fr/entreprises/${siren}`,
     'Dépôts statutaires, bénéficiaires effectifs, comptes annuels.', 'INPI'],
    ['Publications BODACC', `https://www.bodacc.fr/pages/annonces-commerciales/?q=${siren}`,
     'Immatriculation, modifications, procédures collectives, radiation.', 'DILA'],
    ['Recherche d\'entreprises', `https://recherche-entreprises.api.gouv.fr/search?q=${siren}`,
     'La même fiche, lisible par machine.', 'API DINUM'],
  ];
  return `<details><summary>Registres officiels</summary>
    <p class="meta">Annuaire des Entreprises, RNE, BODACC : les sources officielles sur cette société, hors Peppol.</p>
    <dl>${l.map(([n, href, why, src]) => `<dt><a href="${esc(href)}" rel="noreferrer noopener" target="_blank">${esc(n)}</a></dt>
      <dd><span class="sec">${esc(why)} · ${esc(src)}</span></dd>`).join('')}</dl></details>`;
}

const COMMENT = `<details><summary>Comment ça marche</summary><div class="aide">
  <p>Le SML est le registre du réseau Peppol, tenu en DNS. Une requête y donne le serveur (SMP) qui détient la fiche du
    destinataire, puis cette fiche est lue en HTTP sans authentification. Le réseau l'impose : tout expéditeur doit pouvoir
    lire la fiche de son destinataire avant de lui envoyer quoi que ce soit.</p>
  <p>Un identifiant à suffixe est choisi par le destinataire, souvent pour séparer des flux (notes de frais, mandats, marchés
    publics), et un expéditeur doit adresser exactement l'identifiant attendu. Le SML ne se parcourt pas : les suffixes sont
    repérés via le Peppol Directory, puis résolus ici comme les autres. L'essai des suffixes connus ne trouve que ce qu'on a
    déjà vu ailleurs, donc une absence ne prouve rien.</p>
  <p>Les établissements sont listés depuis la base Sirene ouverte, puis chacun est sondé sous sa propre forme SIRET.</p>
</div></details>`;

/**
 * The document in two halves, so it can be written before the answer exists.
 *
 * The whole page used to be built after the slowest source replied, which meant the browser held
 * a blank window and had not even started fetching the stylesheet. Head and search box go out
 * first, the Peppol answer follows as soon as the SMP walk is done, and the sources nobody waits
 * for close the document.
 */
function head(q) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PeppolSonar</title>
<link rel="icon" href="${FAVICON}">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<div class="wrap">
  <h1>${LOGO}PeppolSonar</h1>
  <p class="sub">Savoir si une entreprise française est sur le réseau Peppol, et par quelle plateforme.
    · <a href="/lot">vérifier une liste</a></p>

  <form method="get" action="/" class="search"><div class="champ">
    <input name="q" value="${esc(q || "")}" placeholder="SIREN, SIRET ou nom de société" autocomplete="off" autofocus>
    <button>Chercher</button>
  </div></form>
`;
}

/**
 * Placeholders for what has not been written yet.
 *
 * The document streams, so the wait is visible: header at 3 ms, answer later, and a dead SMP can
 * make "later" thirteen seconds. Each block hides its own placeholder by sending a style rule
 * just before itself, which needs no script and cannot leave a stale skeleton behind: the rule
 * and the content travel together.
 */
const ligne = (w) => `<span class="sk-l" style="width:${w}%"></span>`;
const skeleton = () => [["a", [38, 62]], ["b", [90, 55, 72, 80]], ["c", [30, 80, 80]]].map(([n, l]) =>
  `<div class="card skel skel-${n}" aria-hidden="true">${l.map(ligne).join("")}</div>`).join("");
const posed = (n) => `<style>.skel-${n}{display:none}</style>`;

function foot() {
  return `
</div>
<!-- Progressive enhancement, and the only script on the page: while the browser fetches the
     next page, the logo beats faster. Without it everything still works, it just sits still. -->
<script>
for(const e of document.querySelectorAll('form,a.ghost'))e.addEventListener(e.tagName=='FORM'?'submit':'click',()=>document.body.classList.add('scanning'));
// Click-to-copy on identifiers and URLs. Progressive: without it the values are still selectable.
for(const e of document.querySelectorAll('[data-copy]'))e.addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText(e.dataset.copy||e.textContent.trim());
      const o=e.getAttribute('aria-label');e.setAttribute('aria-label','copié');e.classList.add('copied');
      setTimeout(()=>{e.classList.remove('copied');if(o)e.setAttribute('aria-label',o)},1200);}catch{}
});
</script>
</body>
</html>`;
}

const page = (body, q) => head(q) + body + foot();

// JSON alone does not escape "</script>", which a company name from the register could carry.
const titreOnglet = (nom) => `<script>document.title=${JSON.stringify(`${nom} · PeppolSonar`).replace(/</g, '\\u003c')}</script>`;

// What the pinned Peppol CAs say about a certificate, which is what makes its subject name mean
// anything: any host can serve XML naming any organisation.
const ISSUE = {
  verifie: ['ok', 'certificat délivré par OpenPeppol', "ce nom vient du certificat, pas d'une déclaration libre de l'hébergeur"],
  inconnu: ['warn', 'certificat délivré par une autorité inconnue de nous', "rien n'atteste ce nom de notre côté"],
  invalide: ['bad', 'signature du certificat invalide', "elle ne correspond pas à l'autorité que le certificat invoque"],
  illisible: ['bad', 'certificat illisible', 'rien ne peut être vérifié'],
};
function issueLine(c) {
  const [cls, txt, quoi] = ISSUE[(c && c.issue && c.issue.state) || 'illisible'];
  const par = c && c.issue && c.issue.par && c.issue.state !== 'invalide' ? ` (${c.issue.par})` : '';
  return `<strong class="${cls}">${esc(txt)}</strong> <span class="sec">${esc(quoi)}${esc(par)}</span>`;
}

function certBlock(label, c) {
  if (!c) return `<dt>${label}</dt><dd class="sec">absent</dd>`;
  return `<dt>${label}</dt><dd class="mono">${esc(c.subject)}<br>${issueLine(c)}<br>
    <span class="sec">émis par ${esc(c.issuer || "?")} · du ${esc(c.validFrom)} au ${esc(c.validTo)}
    <strong class="${c.daysLeft < 0 ? "bad" : c.daysLeft < 90 ? "warn" : ""}">(${c.daysLeft} j)</strong><br>
    série ${esc(c.serial)}<br>empreinte ${esc(c.fingerprint)}</span></dd>`;
}

function technical(g, nom) {
  const cmds = g.zones.map((z) => `dig +short NAPTR ${z.dnsName}`).concat(
    g.evidence.flatMap((e) => [`curl -s -A 'Mozilla/5.0' '${e.serviceGroupUrl}'`]
      .concat(e.serviceMetadataUrls.slice(0, 1).map((u) => `curl -s -A 'Mozilla/5.0' '${u}'`))));
  return `<details><summary>Détail technique${nom ? ` : ${esc(nom)}` : ''}</summary><dl>
    <dt>identifiant Peppol AP</dt><dd class="mono">${esc(g.apCert ? g.apCert.cn : "-")}</dd>
    <dt>identifiant Peppol SMP</dt><dd class="mono">${esc(g.smpCert ? g.smpCert.cn : "-")}</dd>
    <dt>processus</dt><dd class="mono">${esc(g.processIds.join(", ") || "-")}</dd>
    ${certBlock("certificat du point d'accès", g.apCert)}
    ${certBlock("certificat du SMP", g.smpCert)}
    <dt>zones SML</dt><dd class="mono">${g.zones.map((z) => `${esc(z.zone)}<br><span class="sec">${esc(z.resolverError ? "résolveur en erreur : " + z.resolverError : z.naptr || "aucune réponse")}<br>TTL ${z.ttl ?? "-"} s · DNSSEC ${z.dnssec ? "validé" : "non validé"}</span>`).join("<br>")}</dd>
    ${g.failedDocTypes.length ? `<dt>doctypes en erreur</dt><dd class="mono">${g.failedDocTypes.map((f) => esc(f.doc) + " (" + esc(f.status || f.error) + ")").join("<br>")}</dd>` : ""}
    ${g.descriptions.length ? `<dt>description publiée</dt><dd class="mono">${g.descriptions.map(esc).join("<br>")}
      <br><span class="sec">texte libre écrit par le SMP ; il nomme souvent l'opérateur et son identifiant Peppol</span></dd>` : ""}
    <dt>types de documents</dt><dd class="mono">${g.docTypes.map((d) => `${esc(d.label)}<br><span class="sec">${esc(d.id)}</span>`).join("<br>") || "-"}</dd>
    <dt>joignabilité AS4</dt><dd>${g.probes && g.probes.length
      ? g.probes.map((pr) => `<span class="mono">${esc(pr.url)}</span> <strong>${
          pr.reachable ? `l'hôte répond (HTTP ${pr.status}, ${pr.ms} ms)` : `pas de réponse à un GET nu (${esc(pr.error)})`}</strong>`).join("<br>")
        + `<br><span class="sec">Une réponse HTTP prouve que l'hôte est debout. L'absence de réponse ne prouve
           <strong>rien</strong> : une passerelle AS4 a le droit d'ignorer un GET non authentifié, et beaucoup le font.
           Seul un envoi AS4 signé teste vraiment la livraison.</span>`
      : `<span class="sec">non testée. <a href="?q=${esc(g.ids[0])}&amp;probe=1">Tester maintenant</a>. L'appel touche la passerelle d'un autre opérateur, il n'est donc jamais automatique.</span>`}</dd>
    <dt>refaire à la main</dt><dd><pre>${esc(cmds.join("\n"))}</pre></dd>
  </dl></details>`;
}

const orgOf = (g) => (g.apCert && g.apCert.org) || g.smpHost;
const pays = (c) => (c && c.country && c.country !== "FR" ? ` <span class="sec">(${esc(c.country)})</span>` : "");
const depuis = (g) => (g.activationFrom ? esc(fr(g.activationFrom)) : '<span class="sec">non publié par ce SMP</span>');
// activationTo is the latest activation among document types, never an end date: that is ServiceExpirationDate.
const derniere = (g) => (g.activationFrom && day(g.activationTo) !== day(g.activationFrom)
  ? `<dt>dernière activation</dt><dd>${esc(fr(g.activationTo))} <span class="sec">un type de document activé après les autres</span></dd>` : "");

const FAMILLES = ["Factur-X", "UBL", "CII", "Statuts de cycle de vie"];
/** Ten variant labels read as four formats; each variant stays in the tooltip and the technical panel. */
function formats(docTypes) {
  const fam = new Map();
  for (const d of docTypes) {
    const ubl = /^(Facture|Avoir) UBL$/.exec(d.syntax);
    const nom = ubl ? "UBL" : d.syntax;
    if (!fam.has(nom)) fam.set(nom, { genres: new Set(), labels: new Set() });
    if (ubl) fam.get(nom).genres.add(ubl[1] === "Facture" ? "factures" : "avoirs");
    fam.get(nom).labels.add(d.label);
  }
  const rang = (n) => (FAMILLES.includes(n) ? FAMILLES.indexOf(n) : FAMILLES.length);
  return [...fam].sort(([a], [b]) => rang(a) - rang(b) || a.localeCompare(b)).map(([nom, f]) => {
    const genres = ["factures", "avoirs"].filter((x) => f.genres.has(x)).join(" et ");
    return `<span class="fmt" title="${esc([...f.labels].join(", "))}">${esc(nom)}${genres ? ` <span class="sec">${genres}</span>` : ""}</span>`;
  }).join("") || "-";
}

/** What a sender needs to deliver. With one platform, the verdict above already names it. */
function group(g, plusieurs) {
  const ap = g.apCert, smp = g.smpCert;
  const titre = plusieurs ? `${esc(orgOf(g))}${pays(ap)} ${g.ids.map(idTag).join("")}` : "Réception";
  return `<div class="card"><h2>${titre}</h2>
    <dl>
      ${plusieurs ? `<dt>actif depuis le</dt><dd>${depuis(g)}</dd>` : ""}
      <dt>adresse de réception</dt><dd class="mono">${g.endpoints.map((e) => `<span class="copy" data-copy="${esc(e)}" role="button" tabindex="0" aria-label="copier l'adresse">${esc(e)}</span>`).join("<br>") || "-"}</dd>
      <dt>formats acceptés</dt><dd>${formats(g.docTypes)}</dd>
      ${derniere(g)}
      <dt>SMP</dt><dd><a class="mono" href="${esc(siteOf(g.smpHost))}" rel="noreferrer noopener" target="_blank">${esc(g.smpHost)}</a>${
        !g.selfHosted && smp ? `<br><span class="sec">hébergé par ${esc(smp.org)}${smp.country ? ` (${esc(smp.country)})` : ""}</span>` : ""}</dd>
      <dt>contact technique</dt><dd>${g.contacts.map((c) => c.startsWith("mailto:") ? `<a href="${esc(c)}">${esc(c.slice(7))}</a>` : esc(c)).join(", ") || '<span class="sec">non publié</span>'}
        ${g.infoUrls.length ? `<br><span class="sec">${g.infoUrls.map((u) => `<a href="${esc(u)}" rel="noreferrer noopener" target="_blank">${esc(u)}</a>`).join(" ")}</span>` : ""}</dd>
      ${ap && ap.issue && ap.issue.state === 'verifie' ? "" : `<dt>certificat</dt><dd>${ap ? issueLine(ap)
        : '<strong class="warn">aucun certificat publié : le nom de la plateforme vient de l\'hôte, rien ne l\'atteste</strong>'}</dd>`}
    </dl>
  </div>`;
}

/** Nothing qualifies the answer: one platform, both registers agreeing, no clock running out. */
function isHealthy(d) {
  // Une 0225 muette pendant qu'une autre forme répond laisse la plupart des expéditeurs sans route.
  if ((d.forms || []).some((f) => f.status !== 'ok' && f.id.startsWith('0225:'))) return false;
  return d.groups.length === 1 && !d.failedForms.length
    && !d.groups.some((g) => g.zoneSilent.length
      || (g.certDaysLeft != null && g.certDaysLeft < 90));
}

/** The registrable domain of a host, to offer a link to the SMP operator's own site. */
const siteOf = (host) => (host ? 'https://' + host.split('.').slice(-2).join('.') : null);

/**
 * Who was looked up, and the answer in one line.
 *
 * The verdict used to head the result card, which left it nowhere to go when there was no card:
 * absent, unreachable, or pointing elsewhere. It belongs to the company, not to the evidence.
 */
function identite(ent, d, etat) {
  const quoi = /^\d{14}$/.test(d.input) ? 'SIRET' : /^\d{9}$/.test(d.input) ? 'SIREN' : 'identifiant';
  const l = [`${quoi} ${d.input}`, ent && ent.ville, ent && ent.cat,
    ent && ent.creation ? `créée en ${ent.creation.slice(0, 4)}` : null,
    ent && ent.cessee ? 'cessée' : null].filter(Boolean);
  const g = d.groups[0];
  const ou = d.groups.length > 1
    ? `${d.groups.map((x) => `<strong>${esc(orgOf(x))}</strong>`).join(" et ")}, selon l'identifiant adressé`
    : g ? `chez <strong>${esc(orgOf(g))}</strong>${pays(g.apCert)}${g.activationFrom
      ? ` depuis le <strong>${esc(fr(g.activationFrom))}</strong>`
      : ` <span class="sec">date d'activation non publiée</span>`}` : "";
  return `<div class="identite"><div class="qui"><span class="who">${esc((ent && ent.nom) || d.input)}</span>
    <span class="sec">${esc(l.join(' · '))}</span></div>
    <div class="verdict"><span class="pill${etat.cls}">${esc(etat.txt)}</span>${ou ? `<span class="ou">${ou}</span>` : ""}</div></div>`;
}

/** The answer in six words, which is also what colours the pill. */
function etatDe(d, ctx) {
  // Deux plateformes, c'était une pastille ambre au-dessus d'une bannière rouge : une seule des
  // deux disait la gravité. Selon l'identifiant choisi, la facture n'arrive pas au même endroit.
  if (d.groups.length > 1) return { cls: ' b', txt: 'Deux plateformes' };
  if (d.groups.length) {
    return isHealthy(d) ? { cls: '', txt: 'Joignable' }
      : { cls: ' w', txt: 'Joignable, avec des réserves' };
  }
  if (d.failedForms.length) return { cls: ' b', txt: 'Enregistrée, mais injoignable' };
  if (ctx.parent && ctx.parent.groups.length) {
    return { cls: ' w', txt: /^\d{14}$/.test(d.input) ? "Cet établissement n'est pas enregistré" : "Cet identifiant n'est pas enregistré" };
  }
  if ((ctx.boxes || []).some((b) => b.groups.length)) return { cls: ' w', txt: 'Joignable sous un identifiant à suffixe' };
  return { cls: ' dim', txt: 'Absente de Peppol' };
}

// A reader who came to know whether they can invoice someone should not have to read "HTTP 504".
const HTTP_FR = {
  500: 'signale une erreur interne',
  502: 'a reçu une réponse invalide du service derrière sa passerelle',
  503: 'se déclare indisponible',
  504: "n'a pas obtenu de réponse du service derrière sa passerelle",
  403: 'refuse la lecture',
  404: "n'a aucune fiche à ce nom",
};
// Rend une suite de « ce serveur », ou null quand la panne n'est pas celle du serveur mais du contenu.
const panne = (f) => HTTP_FR[f.errorStatus] || (/timeout/i.test(f.error) ? "n'a pas répondu dans le délai" : null);

function banners(d, boxes, parent, siren) {
  const out = [];
  // A SIRET absent from Peppol is the common case and rarely the answer: what the reader needs is
  // whether the company behind it is reachable at SIREN level.
  const parentGroup = parent && parent.groups[0];
  // A suffixed box answering while the standard forms do not is not absence, it is the opposite:
  // reachable, but only for a sender who was told the exact suffix. Deciding without looking at
  // the boxes is how the page came to contradict its own table further down.
  const parSuffixe = (boxes || []).filter((b) => b.groups.length);
  // Everything else of this company that does answer, which is what the reader needs whenever the
  // identifier they typed does not: absent, or registered and unreadable.
  const ailleurs = [
    ...(parentGroup ? [{ q: siren, org: orgOf(parentGroup), depuis: day(parentGroup.activationFrom) }] : []),
    ...parSuffixe.map((b) => ({ q: b.input, nom: b.nom, org: orgOf(b.groups[0]), depuis: day(b.groups[0].activationFrom) })),
  ];
  // One target reads as a button; several read as a list, because a row of buttons repeats each
  // identifier twice, once in the sentence and once on its own label.
  const boutons = ailleurs.length === 1
    ? `<a class="ghost" href="/?q=${encodeURIComponent(ailleurs[0].q)}">Voir la fiche de ${esc(ailleurs[0].q)}</a>` : '';
  const liste = ailleurs.length > 1 ? `<div class="picks">${ailleurs.map((a) => `<a class="pick" href="/?q=${
    encodeURIComponent(a.q)}"><span class="pid">${esc(a.q)}</span><span class="pmeta">${
    esc([a.nom, a.org, a.depuis ? `depuis ${a.depuis}` : null].filter(Boolean).join(' · '))}</span></a>`).join('')}</div>` : '';

  if (!d.groups.length && !d.failedForms.length && parentGroup) {
    const quoi = /^\d{14}$/.test(d.input) ? "Cet établissement" : "Cet identifiant";
    out.push(`<div class="banner b-warn">${quoi} n'est pas enregistré sur Peppol, mais l'entreprise l'est. Le SIREN <code>${esc(siren)}</code> est joignable chez <strong>${esc((parentGroup.apCert && parentGroup.apCert.org) || parentGroup.smpHost)}</strong> : une facture adressée au SIREN arrive, une facture adressée à ${/^\d{14}$/.test(d.input) ? "ce SIRET" : "cet identifiant"} n'arrive pas.<br><a class="ghost" href="/?q=${esc(siren)}">Voir la fiche du SIREN</a></div>`);
  } else if (!d.groups.length && !d.failedForms.length && parSuffixe.length) {
    out.push(`<div class="banner b-warn">Joignable, mais sous un identifiant à suffixe uniquement. Les formes standard ne sont publiées nulle part : un expéditeur qui adresse ${
      d.absentSchemes.map((sc) => `<code>${esc(sc)}:${esc(d.input)}</code>`).join(" ou ")} ne trouve personne. ${
      ailleurs.length > 1 ? `Ce SIREN publie ${ailleurs.length} identifiants à suffixe, et un suffixe ne se devine pas` :
      `<code>${esc(ailleurs[0].q)}</code> chez ${esc(ailleurs[0].org)} répond, mais ce suffixe ne se devine pas`} : le destinataire doit indiquer lequel utiliser.${boutons ? `<br>${boutons}` : ''}</div>`);
    if (liste) out.push(liste);
  } else if (!d.groups.length && !d.failedForms.length) {
    // At SIREN level a SIRET can still be registered on its own, and the page may show no card that says so.
    const niveauSiren = !!siren && !/\d{14}/.test(d.input) && !d.input.includes('_');
    out.push(`<div class="banner b-dim">Absente de Peppol${niveauSiren ? ' au niveau du SIREN' : ''}. ${
      niveauSiren
        ? `Aucun de ses identifiants de SIREN n'est enregistré. Un établissement peut toutefois l'être seul, sous sa propre forme SIRET.`
        : `Cette entreprise n'y est enregistrée sous aucun identifiant, donc personne ne peut lui adresser de facture par ce réseau.`} Deux suites possibles : lui demander l'identifiant exact auquel elle veut recevoir ses factures, ou vérifier plus tard, l'enregistrement étant posé par sa plateforme le jour où elle en choisit une.<br><span class="sec">Schémas testés : ${d.absentSchemes.join(", ")}.</span></div>`);
  } else if (d.groups.length > 1) {
    out.push(`<div class="banner b-bad">Les identifiants de ce SIREN ne pointent pas au même endroit : ${
      d.groups.map((g) => `${esc(g.ids.join(" et "))} chez ${esc(orgOf(g))}`).join(", ")}. Selon celui qu'utilise l'expéditeur, la facture n'arrive pas au même endroit.</div>`);
  }
  for (const f of d.failedForms) {
    // Whether the whole SMP is down or only this record changes who else is affected, so it is
    // measured on the SMP's own root and said outright rather than left to the reader.
    const dead = f.smpAlive && f.smpAlive.alive === false;
    const cause = panne(f);
    const titre = dead ? 'Enregistrée, mais son serveur ne répond plus'
      : f.errorStatus === 404 ? 'Enregistrée, mais sans fiche chez le serveur désigné'
      : cause ? 'Enregistrée, mais sa fiche ne se lit pas'
      : 'Enregistrée, mais sa fiche ne mène à rien';
    // Deux acteurs, nommés chacun à son tour : le registre renvoie, le serveur répond.
    const portee = dead
      ? `La panne n'est pas propre à cette entreprise : ce serveur ne répond pas non plus sur sa racine, donc <strong>tous les participants qu'il héberge sont injoignables</strong> tant qu'elle dure.`
      : f.smpAlive ? `Ce serveur n'est pas en panne pour autant : sa racine répond.` : '';
    out.push(`<div class="banner b-bad"><strong>${titre}.</strong> Le registre du réseau (SML) renvoie <code>${esc(f.id)}</code> vers <strong>${esc(f.smpHost || "un serveur")}</strong>. ${cause ? `Interrogé sur cet identifiant, ce serveur <strong>${esc(cause)}</strong>.` : `Sa fiche existe, mais elle n'est pas exploitable : <strong>${esc(f.error)}</strong>.`} ${portee} L'expéditeur trouve donc le serveur, mais pas l'adresse de livraison : aucune facture ne part, le réseau imposant de lire la fiche du destinataire avant d'envoyer.${
      f.errorStatus || f.smpAlive ? `<br><span class="sec">fiche : HTTP ${f.errorStatus || "sans réponse"} · racine du serveur : ${
        f.smpAlive ? (f.smpAlive.alive ? `HTTP ${f.smpAlive.status}` : esc(f.smpAlive.error || "sans réponse")) : "non testée"}</span>` : ""}</div>`);
  }
  // 0002 non publié pendant que 0225 répond est le cas courant, l'inverse non : c'est la forme que
  // les expéditeurs français adressent par défaut, donc son absence est la seule qui se signale.
  const muettes = (d.forms || []).filter((f) => f.status !== 'ok' && f.id.startsWith('0225:')).map((f) => f.id);
  if (d.groups.length === 1 && muettes.length) {
    const g = d.groups[0];
    out.push(`<div class="banner b-warn">Les formes de ce SIREN ne sont pas dans le même état. <code>${
      g.ids.map(esc).join('</code>, <code>')}</code> répond chez <strong>${esc((g.apCert && g.apCert.org) || g.smpHost)}</strong>, ${
      muettes.map((id) => `<code>${esc(id)}</code>`).join(', ')} non, alors que c'est la forme qu'un expéditeur français adresse par défaut. Une facture n'arrive que si l'expéditeur adresse exactement ${
      g.ids.length > 1 ? 'une de celles qui répondent' : `<code>${esc(g.ids[0])}</code>`}.</div>`);
  }
  // The identifier that was asked about is dead, but the company is reachable under another one:
  // that is the way out, and without it the page states a problem and stops there.
  if (!d.groups.length && d.failedForms.length && ailleurs.length) {
    out.push(`<div class="banner b-warn">En revanche, ${ailleurs.length > 1
      ? `${ailleurs.length} autres identifiants de ce SIREN répondent`
      : `un autre identifiant de ce SIREN répond : <code>${esc(ailleurs[0].q)}</code> chez <strong>${esc(ailleurs[0].org)}</strong>`}. C'est là qu'une facture arriverait, à condition d'adresser exactement cet identifiant.${boutons ? `<br>${boutons}` : ''}</div>`);
    if (liste) out.push(liste);
  }
  // An expired access point certificate stops deliveries silently.
  for (const g of d.groups) {
    if (g.certDaysLeft != null && g.certDaysLeft < 0) {
      out.push(`<div class="banner b-bad">Certificat du point d'accès expiré depuis ${-g.certDaysLeft} j.</div>`);
    } else if (g.certDaysLeft != null && g.certDaysLeft < 90) {
      out.push(`<div class="banner b-warn">Certificat du point d'accès valide encore ${g.certDaysLeft} j.</div>`);
    }
  }
  const silent = [...new Set(d.groups.flatMap((g) => g.zoneSilent))];
  // A silent zone is a failed measurement, not a contradiction: say so, and offer the re-run.
  if (silent.length) out.push(`<div class="banner b-warn">Un des deux registres du réseau (SML) n'a pas répondu : ${silent.map(esc).join(", ")}. L'autre a répondu, donc c'est probablement un raté passager. Rejouer sans cache pour confirmer.</div>`);
  // A zone that answers it does not hold the participant is a different finding, and it used to be
  // announced as a resolver hiccup. Both resolvers say the same thing, so it is the zone's content.
  // Lu sur les formes : une fiche illisible n'a pas de groupe, et c'est là que la zone explique le plus.
  return out.join("");
}

const pl = (n, mot) => `${n} ${mot}${n > 1 ? "s" : ""}`;

/** One line; the establishments registered on their own are listed with the identifiers. */
function etabSection(e, probed, absente) {
  const trouves = (probed || []).filter((r) => r && (r.groups.length || r.failedForms.length));
  // A lone establishment repeats the head office, unless the SIREN is absent and it is the only remaining question.
  if (e.activeTotal <= 1 && !trouves.length && !absente) return '';
  const n = e.etablissements.length;
  const notes = [];
  if (e.incomplete) notes.push(`l'INSEE en annonce ${e.inseeTotal} au total contre ${e.listed} dans la liste ouverte, qui est donc possiblement incomplète`);
  if (e.truncated) notes.push(`seuls les ${n} premiers sont listés`);
  if (e.probeLimited) notes.push(`sondage limité aux ${e.probeLimited} premiers`);
  const sous = notes.length ? `<br><span class="sec">${notes.join(" · ")}</span>` : "";
  const actifs = pl(e.activeTotal, "actif");
  const ligne = (txt) => `<p class="ligne"><span class="lib">Établissements</span> ${txt}${sous}</p>`;
  if (!n) return `<div class="card etabs">${ligne("aucun établissement actif à sonder.")}</div>`;
  if (!probed) {
    return `<div class="card etabs">${ligne(`${actifs}, pas encore vérifiés sur Peppol.`)}
      <a class="ghost" href="/?q=${esc(e.siren)}&amp;etabs=1">Sonder ${n > 50 ? "les 50 premiers" : `les ${n}`} établissements sur Peppol</a></div>`;
  }
  const absents = probed.filter((r) => r && !r.groups.length && !r.failedForms.length);
  const liste = absents.length
    ? `<details class="liste"><summary>${absents.length > 1 ? `voir les ${absents.length} sans enregistrement propre` : "voir le SIRET"}</summary><pre>${
        esc(absents.map((r) => `${r.input}  ${(e.etablissements.find((x) => x.siret === r.input) || {}).commune || ""}`).join("\n"))}</pre></details>`
    : "";
  if (!trouves.length) {
    return `<div class="card etabs">${ligne(e.activeTotal > 1
      ? `${actifs}, aucun n'a son propre enregistrement Peppol.` : `${actifs}, sans enregistrement Peppol propre.`)}${liste}</div>`;
  }
  const k = trouves.length;
  return `<div class="card etabs">${ligne(`${actifs}, ${k > 1 ? `${k} ont leur propre enregistrement Peppol, listés`
    : e.activeTotal > 1 ? "1 a son propre enregistrement Peppol, listé" : "avec son propre enregistrement Peppol, listé"} dans les identifiants.`)}${liste}</div>`;
}

const smpOf = (g) => (g.smpCert && g.smpCert.org) || g.smpHost;
// `deja` is the SMP already named above, which the table does not repeat on every row.
const plateforme = (g, deja) => `<strong>${esc(orgOf(g))}</strong>${
  !g.selfHosted && g.smpCert && smpOf(g) !== deja ? `<br><span class="sec">SMP chez ${esc(g.smpCert.org)}</span>` : ""}`;

/** Every identifier of this company in one table; a platform other than the verdict's stands out in colour. */
function identifiants(d, { boxes, siren, sonde, etabs, probed }) {
  const formes = d.forms || d.groups.flatMap((g) => g.ids.map((id) => ({ id })));
  const deja = d.groups.length === 1 ? smpOf(d.groups[0]) : null;
  const principale = d.groups.length === 1 ? orgOf(d.groups[0]) : null;
  const ligne = (ids, nom, g, cellule) => `<tr>
    <td class="mono" title="${esc(SCHEME_LABEL[ids[0].split(":")[0]] || "")}">${ids.map(esc).join("<br>")}${nom ? `<br><span class="sec">${esc(nom)}</span>` : ""}</td>
    <td${principale && g && orgOf(g) !== principale
      ? ` class="ailleurs" title="Pas la plateforme du verdict : une facture adressée à cet identifiant part chez ${esc(orgOf(g))}."` : ""}>${g ? plateforme(g, deja) : cellule}</td>
    <td class="mono">${esc((g && fr(g.activationFrom)) || "-")}</td></tr>`;
  // Registered but unreadable is not absence: the SML has it, the SMP does not follow.
  const illisible = (f) => `<strong class="bad">${f.errorStatus === 404 ? "sans fiche" : "fiche illisible"}</strong> chez ${
    esc(f.smpHost || "?")}<br><span class="sec">${esc(f.errorStatus ? `HTTP ${f.errorStatus}` : f.error)}</span>`;
  const rows = formes.map((f) => {
    const g = d.groups.find((x) => x.ids.includes(f.id));
    const casse = (d.failedForms || []).find((x) => x.id === f.id);
    return ligne([f.id], null, g, casse ? illisible(casse) : '<span class="sec">non enregistré</span>');
  });
  const vus = new Set(formes.map((f) => f.id.toLowerCase()));
  const lieux = Object.fromEntries(((etabs && etabs.etablissements) || [])
    .map((x) => [x.siret, [x.commune, x.siege ? "siège" : null].filter(Boolean).join(" · ")]));
  for (const r of probed || []) {
    if (!r) continue;
    for (const g of r.groups) rows.push(ligne(g.ids, lieux[r.input], g));
    if (!r.groups.length) for (const f of r.failedForms) rows.push(ligne([f.id], lieux[r.input], null, illisible(f)));
    for (const f of r.forms || []) vus.add(f.id.toLowerCase());
  }
  for (const b of [...(boxes || []), ...((sonde && sonde.trouves) || [])]) {
    if (vus.has(b.input.toLowerCase())) continue;
    vus.add(b.input.toLowerCase());
    rows.push(ligne([b.input], b.nom, b.groups[0], '<span class="sec">injoignable</span>'));
  }
  if (rows.length < 2 && !siren) return "";
  const essai = !siren ? ""
    : !sonde ? `<p class="pied"><a class="ghost" href="?q=${esc(siren)}&amp;suffixes=1">Essayer les suffixes connus</a>
        <span class="sec">un suffixe ne se devine pas toujours : une absence ne prouve rien</span></p>`
    : `<p class="pied sec">${sonde.essayes} suffixes essayés, ${sonde.trouves.length
        ? `${sonde.trouves.length} trouvé${sonde.trouves.length > 1 ? "s" : ""}` : "aucun ne répond, le destinataire peut en utiliser un autre"}. Une absence ne prouve rien.</p>`;
  return `<div class="card"><h2>Identifiants Peppol</h2>
    <table><thead><tr><th>Identifiant</th><th>Plateforme</th><th>Depuis</th></tr></thead><tbody>${rows.join("")}</tbody></table>
    ${essai}</div>`;
}

/** Name search: the register answers who, the reader picks, and only then do we touch Peppol. */
function candidats(q, found) {
  if (!found) return `<div class="err">L'annuaire des entreprises n'a pas répondu. Réessayer, ou saisir directement un SIREN.</div>`;
  if (!found.results.length) return `<div class="banner b-dim">Aucune entreprise trouvée pour « ${esc(q)} ».</div>`;
  const rows = found.results.map((r) => `<tr><td class="mono"><a href="/?q=${esc(r.siren)}">${esc(r.siren)}</a></td>
    <td><strong>${esc(r.nom)}</strong>${r.cessee ? ' <span class="sec">cessée</span>' : ""}</td>
    <td>${esc(r.ville || "")}</td><td class="sec">${esc(r.cat || "")}</td></tr>`).join("");
  return `<div class="card"><h2>Quelle entreprise ?</h2>
    <p class="meta">${found.total >= 10000 ? "Plus de 10 000 résultats" : `${found.total} résultat${found.total > 1 ? "s" : ""}`} pour « ${esc(q)} », les ${found.results.length} premiers.
      <br><span class="sec">Peppol ne se cherche pas par nom : son registre est un index haché. Le nom est résolu dans l'annuaire des entreprises (DINUM), puis le SIREN retenu est sondé sur Peppol.</span></p>
    <table><thead><tr><th>SIREN</th><th>société</th><th>commune</th><th>catégorie</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/**
 * D'où vient la réponse, écrite en pied de page.
 *
 * Elle annonçait « mesuré le <maintenant> en 4 ms » sur une réponse servie depuis le cache : la
 * date était celle de l'affichage, et les 4 ms ceux de la lecture du cache. On compte donc les
 * appels réellement partis sur le réseau, et on le dit.
 */
const provenance = (d, reseau) => `<p class="prov src">${reseau
  ? `mesuré à l'instant, en ${d.ms} ms`
  : 'en cache, mesuré il y a moins de 10 min'} · <a href="/?q=${esc(d.input)}&amp;fresh=1">rejouer sans cache</a>
  · <a href="/api/lookup?q=${esc(d.input)}">JSON</a></p>`;

/** Everything the reader came for, written as soon as the SMP walk is done. */
function resultMain(d, { ent, boxes, parent, siren }) {
  const etat = etatDe(d, { parent, boxes });
  return `${identite(ent, d, etat)}${banners(d, boxes, parent, siren)}`;
}

/** The identifiers first, then where to deliver: written once the Directory has had its say. */
const resultCards = (d, { boxes, siren, sonde, redirige, etabs, probed }) => (redirige ? ""
  : `${identifiants(d, { boxes, siren, sonde, etabs, probed })}${d.groups.map((g) => group(g, d.groups.length > 1)).join("")}`);

/**
 * La publication dans le Peppol Directory, écrite après la carte.
 *
 * Elle tenait une ligne de la carte, donc le verdict attendait l'index (530 ms, parfois 1,5 s)
 * pour une information qui ne change rien à la livraison.
 */
function annuaire(d, publies) {
  if (!publies || !d.groups.length) return '';
  // Publiée, il n'y a rien à en faire : la publication ne change rien à la livraison. C'est son
  // absence qui se décide, puisqu'elle rend l'entreprise introuvable des outils de recherche.
  if (d.groups.every((g) => g.ids.some((id) => publies.has(id)))) return '';
  // Une note, pas une carte : ce n'est pas un constat sur l'entreprise mais sur ce que d'autres outils diront.
  return `<p class="note">Non publiée dans le <span class="info" title="Un expéditeur qui connaît l'identifiant livre normalement : la publication dans cet index ne joue aucun rôle dans l'acheminement. En revanche les outils de recherche grand public le lisent, donc ils répondront que cette entreprise n'est pas sur Peppol.">Peppol Directory</span>, sans effet sur la livraison.</p>`;
}

// Ce que la zone en retrait traîne encore, dit en note et non en alerte : elle ne décide plus rien.
function reliquat(d) {
  const vus = new Map();
  for (const f of d.forms || []) for (const r of f.reliquats || []) vus.set(`${f.id}~${r.zone}`, { id: f.id, ...r });
  if (!vus.size) return '';
  return `<div class="card"><h2>Zone SML en retrait</h2><p class="meta" style="margin:0">${
    [...vus.values()].map((r) => `<code>${esc(r.id)}</code> n'est plus publié dans <code>${esc(ZONES_LABEL)}</code>, mais une entrée subsiste dans <code>${esc(r.zone)}</code> et renvoie vers <strong>${esc(r.smp)}</strong>.`).join('<br>')}
    <br><span class="sec">Cette zone n'est plus répliquée depuis les activités finales de migration du 2 septembre 2026 et sera éteinte par la Commission européenne. Elle ne dit plus ce que le réseau fait aujourd'hui.</span></p></div>`;
}

/** Folded away at the bottom: the technical panel of each platform, the registers, and the how. */
const plus = (d, siren) => `<div class="card plus">${
  d.groups.map((g) => technical(g, d.groups.length > 1 ? orgOf(g) : null)).join("")}${siren ? registres(siren) : ""}${COMMENT}</div>`;

/** The rest, in the same order whatever the case: nobody holds their breath for it. */
const resultRest = (d, { etabs, probed, siren, redirige, publies }) => {
  // The page sent the reader to the SIREN: what belongs to the SIREN belongs on that page too.
  if (redirige) return plus(d, null);
  return `${annuaire(d, publies)}${reliquat(d)}${etabs ? etabSection(etabs, probed, !d.groups.length) : ""}${plus(d, siren)}`;
};

const AIDE = `<div class="card"><h2>Ce que la liste doit contenir</h2>
  <dl>
    <dt>une entreprise par ligne</dt><dd>L'identifiant peut se trouver n'importe où dans la ligne, le premier reconnu est retenu. Le reste de la ligne est ignoré.</dd>
    <dt>identifiants acceptés</dt><dd>SIREN (9 chiffres), SIRET (14), numéro de TVA française, ou identifiant Peppol complet tel que <code>0225:810319517</code>. Espaces, points et tirets tolérés.</dd>
    <dt>fichier</dt><dd>CSV ou texte, déposé ou choisi ci-dessus. Le séparateur et l'encodage n'ont pas d'importance : seuls des chiffres sont lus. Le fichier ne quitte pas le navigateur, c'est son texte qui est envoyé.</dd>
    <dt>lignes écartées</dt><dd>Lignes vides, en-têtes de colonnes, clés de contrôle fausses. Elles sont listées avec leur motif à l'écran suivant, jamais ignorées en silence.</dd>
    <dt>plafond</dt><dd>${MAX_LIGNES} lignes par lot.</dd>
  </dl></div>`;

// Le texte collé est la source : le fichier déposé ne fait que le remplir, donc rien à envoyer en multipart.
function lotForm(texte, erreur) {
  return `<h2 class="titre">Vérifier une liste</h2>
  ${erreur ? `<div class="err">${esc(erreur)}</div>` : ''}
  <form method="post" action="/lot" class="bloc">
    <div class="depot" id="depot">
      <textarea name="texte" rows="12" placeholder="Collez ici une liste de SIREN, de SIRET ou d'identifiants Peppol, un par ligne." autofocus>${esc(texte || '')}</textarea>
      <p class="sec" id="depot-aide">Glissez un fichier ici, ou <label class="lien">choisissez-en un<input type="file" id="fichier" accept=".csv,.txt,text/*" hidden></label>.</p>
    </div>
    <button>Lire la liste</button>
  </form>
  ${AIDE}
  <script src="/lot.js" defer></script>`;
}

const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? 's' : ''}`;

// Aucun appel n'est encore parti : cet écran est là pour que le lecteur voie ce qui a été compris.
function lotRecap(lu, texte) {
  const rejets = lu.rejets.length ? `<div class="card"><h2>${pluriel(lu.rejets.length, 'ligne')} écartée${lu.rejets.length > 1 ? 's' : ''}</h2>
    <table><tbody>${lu.rejets.map((r) => `<tr><td class="mono">${esc(r.brut)}</td><td class="sec">${esc(r.motif)}</td></tr>`).join('')}</tbody></table></div>` : '';
  return `<h2 class="titre">${pluriel(lu.lignes.length, 'entreprise')} à vérifier</h2>
  <p class="meta">${lu.doublons ? `${pluriel(lu.doublons, 'doublon')} retiré${lu.doublons > 1 ? 's' : ''}. ` : ''}${
    lu.tronque ? `La liste dépasse le plafond, seules les ${MAX_LIGNES} premières sont retenues. ` : ''}Rien n'est encore parti sur le réseau.</p>
  ${lu.lignes.length ? `<form method="post" action="/lot" class="bloc">
    <input type="hidden" name="texte" value="${esc(texte)}">
    <input type="hidden" name="go" value="1">
    <div class="card"><h2>Avant de lancer</h2>
      <p class="choix"><label><input type="checkbox" name="complet" value="1"> Détail complet : les deux formes d'identifiant et tous les types de documents. Environ neuf fois plus de requêtes.</label></p>
      <p class="choix"><label><input type="checkbox" name="annuaire" value="1"> Vérifier aussi la publication dans le Peppol Directory.</label></p>
    </div>
    <button>Lancer sur ${pluriel(lu.lignes.length, 'entreprise')}</button>
    <a class="ghost" href="/lot">Corriger la liste</a>
  </form>` : '<p><a class="ghost" href="/lot">Reprendre la liste</a></p>'}
  ${rejets}`;
}

const STATUT = { joignable: 'ok', injoignable: 'bad', absente: 'sec', erreur: 'bad' };

const lotHead = (n) => `<h2 class="titre">Lot de ${pluriel(n, 'entreprise')}</h2>
  <div class="card"><table><thead><tr><th>saisie</th><th>identifiant</th><th>statut</th><th>plateforme</th><th>depuis</th><th>réserve</th></tr></thead><tbody>`;

const lotRow = (r) => `<tr><td class="mono">${esc(r.saisie)}</td><td class="mono">${esc(r.identifiant)}</td>
  <td class="${STATUT[r.statut] || ''}">${esc(r.statut)}</td><td>${esc(r.plateforme)}</td>
  <td class="mono">${esc(fr(r.actif_depuis))}</td><td class="sec">${esc(r.reserve)}</td></tr>`;

const lotFoot = (r, jeton) => `</tbody></table></div>
  <p class="prov">${r.joignable} joignable${r.joignable > 1 ? 's' : ''} · ${r.injoignable} injoignable${r.injoignable > 1 ? 's' : ''} · ${r.absente} absente${r.absente > 1 ? 's' : ''}${
    r.erreur ? ` · ${r.erreur} en erreur` : ''} · ${r.appels} appels réseau pour ${pluriel(r.lignes, 'ligne')}, soit ${(r.appels / Math.max(1, r.lignes)).toFixed(1)} par ligne · ${(r.ms / 1000).toFixed(1)} s</p>
  <p><a class="ghost" href="/lot.csv?t=${esc(jeton)}">Télécharger le CSV</a> <a class="ghost" href="/lot">Nouveau lot</a></p>`;

module.exports = { page, head, foot, skeleton, posed, resultMain, resultCards, resultRest, candidats, provenance, esc, titreOnglet,
  lotForm, lotRecap, lotHead, lotRow, lotFoot,
  // Exposed for the tests only: the verdict wording is where the page last contradicted itself.
  __test: { banners, etabSection, reliquat, identifiants, formats, resultRest, annuaire } };
