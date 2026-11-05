# PeppolSonar

On tape un SIREN, un SIRET, un numéro de TVA, un nom de société ou un identifiant Peppol, et la
page répond si cette entreprise peut recevoir des factures sur le réseau Peppol, par quelle
plateforme, et à quelles adresses.

Ce document se lit de bout en bout sans être technique. Les paragraphes marqués **En technique**
donnent le détail de mise en oeuvre et peuvent être sautés sans perdre le fil.

```bash
node server.js     # http://localhost:4321 : zéro dépendance, Node 20+
HOST=0.0.0.0 node server.js   # pour l'ouvrir au réseau local, fermé par défaut
node --test        # tests de non-régression, hors ligne
```

Une fiche s'ouvre aussi par son chemin : `/810319517`, `/0225:922078522`.

## En un paragraphe

**Sans technique.** PeppolSonar ne consulte aucun fichier de clients et ne connaît personne
d'avance : il pose au réseau Peppol les mêmes deux questions qu'une plateforme pose avant
d'envoyer une facture, à savoir quel opérateur détient la fiche de cette entreprise, puis ce que
dit cette fiche. Il affiche donc ce qu'un expéditeur verrait vraiment, et non ce qu'un annuaire
recopié raconte, ce qui explique qu'il trouve des entreprises que les outils de recherche publics
déclarent introuvables. Autour de cette réponse, il complète avec le registre public des
entreprises pour le nom et la liste des établissements, chaque établissement étant ensuite
interrogé sur Peppol comme une entreprise à part entière, puisqu'une société peut être joignable
par son siège, par un établissement, ou par plusieurs adresses à la fois. Tout ce qui est affiché
a été mesuré au moment de l'affichage, la page le dit, et elle signale ses propres réserves plutôt
que de trancher à votre place : zones en désaccord, certificat qui expire bientôt, fiche illisible.

**En technique.** L'identifiant saisi est normalisé puis développé en ses formes Peppol
(`0002`/`0225` pour un SIREN, `0009`/`0225:<siren>_<siret>` pour un SIRET), chacune résolue dans le
SML par un NAPTR sur `SHA-256(identifiant)` encodé en base32, interrogé en DNS over HTTPS sur deux
zones et deux résolveurs ; l'URL obtenue est celle du SMP, dont on lit le ServiceGroup puis chaque
ServiceMetadata en HTTP non authentifié, ce qui donne l'adresse AS4, les types de documents, les
fenêtres de validité et les deux certificats, dont celui du point d'accès est vérifié hors ligne
contre la chaîne Peppol G3 épinglée dans le dépôt. Les formes sont ensuite regroupées par
(certificat, hôte SMP, adresses) pour n'afficher deux blocs que lorsqu'elles divergent réellement.
Les sources hors Peppol (recherche-entreprises de la DINUM, miroir Sirene, avis de situation INSEE,
Peppol Directory) sont toutes publiques, gratuites, et tenues en laisse : passé leur délai la page
sort sans elles. Le tout est un serveur Node sans dépendance qui écrit sa réponse en quatre fois sur
la même connexion HTTP, verdict d'abord vers 400 ms, puis les identifiants et la réception, puis le reste, avec un cache de dix
minutes par URL et une ligne de provenance qui distingue une mesure fraîche d'une réponse servie
depuis ce cache.

## Cinq mots de vocabulaire

| mot | ce que c'est |
| --- | --- |
| Peppol | le réseau par lequel les plateformes de facturation se livrent les factures |
| participant | une entreprise joignable sur ce réseau, désignée par une adresse comme `0225:810319517` |
| SML | l'annuaire du réseau : il dit quel opérateur détient la fiche d'un participant |
| SMP | la fiche elle-même : l'adresse de livraison et les formats acceptés |
| point d'accès | la passerelle qui reçoit réellement les factures, chez l'opérateur |

L'image la plus proche : le SML dit quel bureau de poste dessert le destinataire, le SMP est sa
fiche exacte chez ce bureau. Il faut lire les deux avant d'envoyer quoi que ce soit, et le réseau
l'impose : les deux sont publics et consultables sans autorisation.

## Périmètre : la France

Un SIREN ou un SIRET est développé dans les formes que notre propre enregistrement publie
(`0002`, `0009`, `0225`). Un identifiant à suffixe collé sans son schéma (`389058447_card`) est
développé en `0225:`, le suffixe étant une convention de ce schéma. Un identifiant Peppol déjà
complet (`0208:07399…`) est accepté tel quel et sondé sans expansion, ce qui dépanne quand on l'a
sous la main, tiré d'un log ou d'un SBD.

L'adressage Peppol couvre bien d'autres schémas (numéros d'organisation étrangers, TVA, GLN), mais
un numéro **nu** ne suffit jamais à les atteindre : le nom DNS est le hachage de `schéma:valeur`,
donc sans le schéma il n'y a rien à interroger. Si ça marche pour un SIREN, c'est parce que la
règle française est codée ici, pas parce que Peppol la fournit.

## 1. Ce que vous tapez

Le champ accepte ce qui vient du monde réel : un SIREN collé avec des espaces, un numéro de TVA
dont les neuf derniers chiffres sont le SIREN, un SIRET, un identifiant Peppol complet, un
identifiant à suffixe, ou un nom de société.

Deux refus utiles avant toute requête : un nombre qui n'a ni 9 ni 14 chiffres, et un numéro dont la
clé de contrôle est fausse. Sans ce second contrôle, `810319518` repartait avec un « absente de
Peppol » parfaitement assuré alors que ce numéro n'existe pas.

**En technique.** `saisie.js` normalise la chaîne, extrait le SIREN d'un numéro de TVA français,
reconnaît un identifiant Peppol à sa forme `NNNN:valeur`, et vérifie la clé de Luhn du SIREN comme
du SIRET. La Poste (`356000000…`) est la seule exception connue à cette clé.

## 2. Chercher par nom

Peppol ne se cherche pas par nom, son registre est un index haché. Un nom est donc d'abord résolu
contre le registre public des entreprises, le lecteur choisit le SIREN, et c'est lui qui est sondé.
Tant qu'aucun candidat n'est retenu, aucune requête Peppol n'est partie.

**En technique.** `entreprise.js` appelle `recherche-entreprises.api.gouv.fr` (DINUM), publique et
sans clé. Le même module sert ensuite à nommer l'entreprise une fois le SIREN connu, parce que le
SMP, lui, ne nomme personne.

## 3. Trouver l'opérateur

Première question : qui détient la fiche de ce participant. La réponse est dans le SML, qui n'est
pas un site web mais une zone DNS, le même système qui traduit un nom de site en adresse de
serveur. On pose la question, on reçoit l'adresse du serveur qui détient la fiche.

Particularité qui commande tout le reste : on ne peut pas demander au SML « donne-moi tout ce que
tu as pour cette entreprise ». Il répond uniquement à une adresse exacte, parce que le nom
interrogé est le résultat d'un calcul à sens unique sur cette adresse. Impossible, donc, de lister
ce qu'on ne connaît pas déjà, ni d'énumérer les SIRET d'un SIREN depuis Peppol.

**En technique.** Le nom DNS est le SHA-256 de la valeur de l'identifiant en minuscules, encodé en
base32, suffixé de `.iso6523-actorid-upis.<zone>` ; le SIREN n'est jamais envoyé en clair. On lit
l'enregistrement NAPTR, dont la donnée contient l'URL du SMP, via DNS over HTTPS en JSON, sur deux
résolveurs, Cloudflare puis Google. Si la zone qui décide n'a rien répondu du tout, la question est
reposée à l'autre résolveur avant d'annoncer un silence. Si elle a répondu « ce nom n'existe pas »,
pas de second avis : c'est son contenu et non un incident.

## 4. Lire la fiche

Deuxième question : que dit cette fiche. On la lit comme n'importe quel expéditeur, en HTTP et sans
authentification. Elle donne l'adresse exacte où arrivent les documents, la liste des formats
acceptés et les dates à partir desquelles l'adresse est valable.

Une entreprise est normalement enregistrée sous deux identifiants qui portent le même endpoint et
le même certificat : les afficher deux fois ne dit rien. Ils sont donc regroupés, et ne se séparent
que lorsqu'ils divergent réellement.

```
810319517  1 groupe  : [0002+0225] API FIRST
922078522  1 groupe  : [0225] TIIME PDP, SMP chez Axway : 0002 non enregistrée
xxxxxxxxx  2 groupes : [0002] API FIRST | [0225] SUPER G
953321098  0 groupe  : absent des deux formes
```

Le cas à deux groupes est la trouvaille qui justifie l'outil : un SIREN dont la forme historique
est chez nous et la forme FR-CTC est partie ailleurs.

**En technique.** GET sur le ServiceGroup, qui liste un lien par type de document, puis un GET par
lien, six en parallèle. De chaque page on extrait l'adresse de livraison, le profil de transport,
les identifiants de processus, les dates d'activation et d'expiration, et les deux certificats. Un
lien qui échoue est rangé à part plutôt que de faire tomber la fiche. Le regroupement se fait sur
le triplet (certificat du point d'accès, hôte du SMP, adresses de livraison).

## 5. Qui est vraiment au bout

N'importe quel serveur peut servir un document qui affirme n'importe quel nom d'entreprise. Ce qui
rend le nom de plateforme digne de confiance, c'est que l'autorité du réseau ait délivré le
certificat qui le porte.

**Les certificats affichés sont lus dans la réponse publique du SMP, à chaque requête.** Aucun
n'est stocké ici, et aucun ne permet quoi que ce soit : un certificat ne contient que de la matière
publique, c'est la clé privée associée, qui ne quitte jamais son propriétaire, qui signe et
authentifie. Le dépôt ne contient que trois certificats, ceux des autorités d'OpenPeppol, qui
servent de référence pour vérifier des signatures et jamais à en produire.

Une fiche en porte deux, et ils ne disent pas la même chose : `<smp:Certificate>` nomme le **point
d'accès**, donc la plateforme du destinataire, et `<ds:X509Certificate>` sous `<Signature>` nomme
celui qui a **signé la fiche**, donc l'hébergeur du SMP. Exemple de sortie, obtenu en interrogeant
deux fiches :

```
922078522  AP  C=FR, O=TIIME PDP, OU=PEPPOL PRODUCTION AP,  CN=PFR000912
           SMP C=BE, O=Axway,     OU=PEPPOL PRODUCTION SMP, CN=PBE000078
810319517  AP  C=FR, O=API FIRST, OU=PEPPOL PRODUCTION AP,  CN=PFR000936
           SMP C=FR, O=API FIRST, OU=PEPPOL PRODUCTION SMP, CN=PFR000936
```

Tiime exploite son propre point d'accès mais son SMP est hébergé et signé par Axway. API FIRST
exploite les deux. L'hébergeur d'infrastructure est donc lu dans la réponse, jamais deviné, et
aucune table n'est codée à la main. Le `CN` n'est pas un nom commercial mais l'identifiant Peppol
de l'opérateur.

**En technique.** `pki.js` épingle la chaîne Peppol G3 (racine, CA des points d'accès, CA des SMP)
et vérifie avec `checkIssued()` puis `verify(publicKey)`. Aller chercher ces certificats au moment
de la vérification reviendrait à ne rien vérifier, d'où l'épinglage. Un émetteur hors de ce socle
est signalé « inconnu », jamais « invalide » : être absent de notre liste n'est pas une preuve de
faux. Un auto-test vérifie que la chaîne épinglée tient contre elle-même. Ne sont **pas** vérifiées
la signature XML de la réponse, qui demanderait la canonicalisation exclusive, ni la chaîne TLS :
le certificat est authentifié, pas la réponse.

## 6. Le verdict

La pastille sous le nom résume, et elle est calculée, pas choisie. Quand une plateforme répond,
elle est nommée à côté, avec sa date d'activation.

| situation | ce qui s'affiche |
| --- | --- |
| une plateforme, rien à signaler | Joignable |
| une plateforme, mais une réserve | Joignable, avec des réserves |
| deux plateformes pour le même SIREN | Deux plateformes |
| enregistrée mais la fiche est illisible | Enregistrée, mais injoignable |
| rien sous cette adresse, mais le SIREN répond | Cet établissement n'est pas enregistré |
| rien nulle part | Absente de Peppol |

Trois états que la mesure distinguait mais que l'affichage mélangeait, jusqu'à annoncer « absente
de Peppol » sur le deuxième, ce qui était faux et masquait la vraie cause :

- **absent** : aucune réponse du registre, sous aucun identifiant ;
- **enregistré mais injoignable** : le registre désigne un SMP, mais ce SMP ne publie aucun service
  ou ne connaît pas la fiche. Un expéditeur trouve le serveur et repart sans adresse de livraison ;
- **joignable** : au moins un type de document et une adresse.

Les réserves qui font basculer le verdict : une forme `0225` muette pendant qu'une autre répond,
l'une des deux zones qui n'a pas le participant, un certificat du point d'accès à moins de 90 jours
de l'expiration. Cette horloge n'est surveillée par personne et arrête les livraisons en silence :
elle est affichée avec ses jours restants, en orange sous 90 jours, en rouge passé le terme.

La date d'expiration de la fiche (`ServiceExpirationDate`) n'est pas affichée. Chaque type de
document a la sienne (sur `810319517`, un an jour pour jour après son activation) : en retenir une seule pour toute la
fiche donnait une date fausse pour une partie des formats, et une alerte trop tardive.

Quand une fiche ne se lit pas, la racine du SMP est interrogée à son tour, avec une laisse courte
de 2,5 s. Une panne d'hôte rend injoignables **tous** les participants qu'il sert, une fiche
illisible sur un serveur qui répond par ailleurs est un autre problème, et la différence est ce que
le message doit dire. Mesuré, pas déduit. Vu le 18/09/2026 sur `328781786` (CAPGEMINI FRANCE) :
résolu vers `snc-netix-smp.sybycegedim.com`, qui répond 504 sur la fiche et rien sur sa racine,
pendant que peppolcheck.fr affichait une fiche verte servie depuis son instantané de la nuit.

## 7. Les établissements

Une entreprise peut être enregistrée au niveau de son SIREN, ou établissement par établissement.
Comme le SML ne sait pas lister, la liste des SIRET vient du registre Sirene, et chaque SIRET est
ensuite interrogé sur Peppol comme n'importe quelle autre adresse. C'est la seule façon de voir
qu'un établissement est joignable alors que le siège ne l'est pas, ou l'inverse. La forme SIRET
(`0009:<siret>`, `0225:<siren>_<siret>`) ne vient d'aucun index : elle est déduite des règles
d'enregistrement et sondée ici. Les établissements enregistrés à part ont leurs identifiants dans
le tableau des identifiants, avec leur commune ; la carte Établissements ne garde qu'une ligne, et la
liste de ceux qui n'ont pas d'enregistrement propre.

Une PME testée en donne le cas pur : rien au niveau du SIREN, et son unique établissement enregistré
chez Tessi avec une fiche qui répond 404. Deux règles en sont sorties, « absente de Peppol » se dit
« au niveau du SIREN » tant que les établissements n'ont pas été sondés, et un établissement dont
la fiche est illisible n'est pas rangé parmi les non enregistrés, il a sa ligne avec l'hôte et le
code HTTP.

Le registre ouvert utilisé est une copie, qui peut être en retard. L'outil demande en parallèle le
total faisant autorité et signale l'écart, plutôt que d'afficher une liste incomplète sans le dire.

**En technique.** Deux sources publiques, exprès (`etablissements.js`) : le miroir OpenDataSoft de
Sirene v3 **liste** les établissements, l'avis de situation INSEE ne renvoie que le siège mais donne
le **total faisant foi**. Sur une entreprise testée : 6 connus du miroir, 7 selon l'INSEE, d'où la mention
« liste possiblement incomplète ». Le filtre « actif » est appliqué par la source, pas après coup :
demander les 100 premières lignes puis compter les actifs dedans sous-estimait, sur `632012100`,
22 actifs là où il y en a 37. Trois chaînes indépendantes partent ensemble, la fiche Peppol du
SIREN, la liste des SIRET et les comptes ; le sondage ne dépend que de la liste, donc il démarre
sans attendre les comptes. Sondage automatique jusqu'à 25 établissements, 50 au maximum, six en
parallèle, sans le diagnostic de disponibilité du SMP qui coûte 2,5 s par forme en échec.

## 8. Les identifiants à suffixe

Une entreprise peut ouvrir plusieurs adresses sous le même SIREN, par exemple pour séparer les
notes de frais des marchés publics. Ces adresses portent un suffixe choisi librement, et il ne se
devine pas : rappel du point 3, le registre ne répond qu'à une adresse exacte.

Le seul endroit public qui les liste est le Peppol Directory. L'outil y cherche des pistes, puis
résout chacune en direct : ce qui s'affiche a répondu, ce n'est pas une citation d'index. Sur
L'Oréal, `_mandat`, `_ztime` et `_achatpub_403201767` ne pointent pas tous vers la même plateforme,
ce qu'aucune source ne dit autrement. Et sur une petite entreprise testée, les formes standard ne sont
publiées nulle part mais sa forme suffixée `_0147_replyto` répond chez Serensia : « absente de Peppol »
ne se décide donc pas avant d'avoir vu les suffixes.

Quand l'index ne connaît rien, il reste la devinette. Un bouton essaie un dictionnaire de suffixes
relevés sur des identifiants réels, noms de plateformes et mots métier. Ni nous ni Chaintrust ne
publions dans l'index, et une entreprise testée est joignable sous un suffixe `_inqom` sans qu'aucune
source publique ne le dise : la sonde l'a retrouvé. L'outil le dit comme tel, trouver quelque chose
prouve, ne rien trouver ne prouve rien.

**En technique.** Un raté s'arrête au DNS : une requête NAPTR par candidat sur la zone qui décide,
aucune touche aux SMP tant qu'il n'y a pas de réponse, et les touches sont résolues en mode allégé.
34 candidats, page complète en 353 ms. La casse est sans effet, le nom DNS portant sur la valeur en
minuscules. Les résultats de l'index sont filtrés sur les schémas français `0002`, `0009`, `0225`
et `9957` : neuf chiffres ne désignent pas une entreprise, un numéro d'organisation norvégien en
compte neuf aussi, et un identifiant norvégien `0192:` (chez PowerOffice) s'affichait comme boîte à
suffixe d'un SIREN français.

## 9. Pourquoi d'autres outils répondent « introuvable »

Publier sa fiche dans le [Peppol Directory](https://directory.peppol.eu) est facultatif, et toutes
les plateformes ne le font pas. Notre SMP a l'intégration désactivée. Les outils de recherche grand
public, peppolcheck.fr compris, lisent cet index et non le réseau : une entreprise parfaitement
joignable peut donc y être déclarée inconnue.

C'est sans effet sur les livraisons, un expéditeur qui connaît l'adresse livre normalement. Mais
c'est l'explication, vérifiable en une requête, de la question « pourquoi tel outil ne le trouve pas
alors que vous dites qu'il est joignable ». Sur une entreprise joignable chez API FIRST dans les
deux zones, l'index répond 0 résultat. La page le signale en note sous la carte, et seulement quand
la fiche n'y est pas publiée : c'est l'absence qui demande une décision.

**En technique.** Deux usages, deux requêtes, parce que ce ne sont pas les mêmes questions :

| question | requête | mesuré |
| --- | --- | --- |
| ce participant est-il publié ? | `?participant=iso6523-actorid-upis::0225:<id>`, par clé | 110 ms |
| quels autres identifiants pour ce SIREN ? | `?q=<siren>`, plein texte | 5 s à froid, 0,5 s ensuite |

La recherche plein texte ne peut pas répondre à la première dans le temps d'une page, et la requête
par clé ne peut pas répondre à la seconde, elle ne devine pas un suffixe.

## 10. Une zone décide, l'autre est un reste

La reprise du SML par OpenPeppol est faite. `participant.sml.prod.tech.peppol.org` est la zone
primaire depuis les activités finales de migration du 2 septembre 2026, et la zone historique
`edelivery.tech.ec.europa.eu` n'est plus répliquée : elle sera éteinte à la discrétion de la
Commission européenne, sans redirection. Les deux échéances qui précèdent concernaient l'endpoint
d'enregistrement des SMP, le 31 mai, et le domaine de résolution des points d'accès, le 31 août.

Mesuré depuis, sur la zone en retrait : une inscription du 23/09 jamais reprise, une du 09/10
reprise, une suppression jamais appliquée, et un participant qui en disparaît puis y revient une
heure plus tard. Elle n'est ni gelée ni fiable.

L'outil l'a donc rétrogradée. **Seule la première zone décide** du verdict, de l'hôte SMP interrogé
et de l'absence. Les autres sont lues, et ce qu'elles portent de différent devient une note sous la
carte : quel identifiant, quelle zone, vers quel serveur. Deux conséquences visibles :

- une entreprise désinscrite dont l'entrée morte survit dans la zone en retrait n'est plus annoncée
  « enregistrée mais injoignable », elle est absente de Peppol, ce qu'elle est ;
- on n'interroge plus le SMP désigné par une zone qui ne fait plus foi, ce qui épargne un appel chez
  un opérateur tiers et un faux 404.

Surchargeable par `SML_ZONES=a,b`, la première nommée faisant foi.

## 11. Vérifier une liste

Une seconde page, `/lot`. On colle une liste ou on y dépose un fichier, un écran dit ce qui a été
compris, les lignes écartées sont nommées avec leur motif, et on lance seulement ensuite : rien
n'est parti sur le réseau avant ce clic.

Le format tient en une phrase, une entreprise par ligne, l'identifiant n'importe où dans la ligne.
Le séparateur d'un CSV et son encodage n'ont pas d'importance puisque seuls des chiffres sont lus.
Le résultat s'affiche ligne à ligne pendant que le lot avance, et se télécharge en CSV.

**En technique.** Une fiche complète vaut 26 appels mesurés sur une fiche réelle, dont 22 sur le SMP d'en
face. Un lot en fait 3 par ligne joignable, par trois renoncements : une seule page de service lue
au lieu de dix, chacune portant déjà l'adresse, le certificat et les dates ; une seule zone du SML ;
arrêt à la première forme qui répond, `0225` d'abord. Le détail complet reste disponible, à cocher
avant de lancer. Une ligne allégée n'a qu'une requête SMP en vol, donc la concurrence des lignes est
aussi le maximum simultané chez un opérateur, sans plafond par hôte à écrire. Le fichier déposé est
lu dans le navigateur et versé dans la zone de texte, donc le serveur ne reçoit qu'un champ de
formulaire, aucun analyseur multipart, et sans JavaScript le collage marche toujours.

## 12. La page part avant la réponse

La réponse qui intéresse arrive en moins d'une demi-seconde, le reste suit. La page est donc
envoyée en quatre fois, dans l'ordre de ce qu'on attend.

| écrit | contenu | mesuré |
| --- | --- | --- |
| tout de suite | en-tête, champ de recherche, feuille de style | 3 ms |
| dès la marche SMP | le verdict | 175 ms |
| dès le Directory et le sondage des SIRET | identifiants, réception | 1,2 s au plus pour le Directory |
| ensuite | établissements, détail technique, registres | 0,02-2 s |

Les identifiants passent avant la réception et comptent les suffixes du Directory et les formes
SIRET : les cartes attendent donc le Directory, tenu en laisse à 1,2 s, et le sondage des
établissements, mesuré à froid entre 0,3 et 0,8 s sur trois entreprises, jusqu'aux 37 SIRET de
`632012100`. Le verdict, lui, n'attend ni l'un ni l'autre.

Pendant l'attente, la place des blocs à venir est tenue par un squelette. Chaque bloc masque le sien
en envoyant une règle CSS juste avant lui : aucun script, et pas de squelette fantôme possible, la
règle et le contenu voyagent ensemble. Les squelettes sont écrits en tête du document, faute de
mieux, mais tiennent la place de ce qui vient après : une règle d'ordre CSS les renvoie sous le
contenu déjà arrivé, sinon la carte s'affichait sous un bloc encore en chargement.

Trois sources lentes tenaient la page entière sans rien changer au verdict, elles sont en laisse :

- la **recherche plein texte du Directory** répond en 5 s sur un SIREN qu'on ne lui a jamais
  demandé, puis en moins d'une seconde. Une page qui a déjà sa réponse l'attend 1,2 s et s'en passe,
  sauf dans le seul cas où elle peut la contredire, quand rien ne répond sous l'identifiant saisi ;
- l'**avis de situation INSEE** a répondu en 35 s. Il ne sert qu'à dire que le miroir Sirene peut
  être en retard sur lui : 2 s, sinon rien ;
- le diagnostic « le SMP est-il debout » coûte 2,5 s par forme en échec, et n'est demandé que pour
  l'identifiant saisi.

Deux dépenses invisibles avec : une poignée de main TLS par requête, alors qu'une fiche SMP c'est
une dizaine d'appels sur le même hôte, et une source en panne dont l'échec n'était pas mémorisé,
donc repayé au prix du délai d'attente par chaque visiteur. La connexion est réutilisée, l'échec est
retenu une minute. Sur une fiche réelle : 6,3 s pour la page entière avant, 2,3 s à froid, 20 ms ensuite.

Les réponses sont gardées dix minutes. La ligne sous la barre de recherche dit toujours si la
réponse vient d'être mesurée ou si elle sort du cache, et un lien rejoue sans cache. Ce lien ne vide
que les clés de la fiche demandée : il appelait `cache.clear()`, donc rejouer une fiche faisait
repartir de zéro toutes les autres. La ligne de provenance se lit sous la barre de recherche alors
qu'elle ne peut s'écrire qu'en dernier, la mesure n'étant connue qu'à la fin : c'est une règle
d'ordre CSS, pas un script et pas une place réservée.

## Ce qui est affiché

Le nom de l'entreprise et son état civil tiennent la première ligne, le verdict la seconde, avec la
plateforme et sa date d'activation en gras : on voit à qui l'on a affaire, puis où va la facture. Le verdict
reste au-dessus des cartes et non dedans, parce qu'il n'aurait nulle part où aller quand il n'y a
pas de carte : absente, injoignable, ou renvoyée ailleurs.

Puis, toujours dans cet ordre :

- le tableau des identifiants Peppol : chaque forme du SIREN, enregistrée ou non, les formes SIRET
  des établissements enregistrés à part, puis les suffixes ;
  la plateforme d'un suffixe servi ailleurs que chez celle du verdict y ressort en couleur ;
- la carte Réception : adresse de réception, formats acceptés regroupés par famille, dernière date
  d'activation quand un type de document a été activé après les autres (ce n'est pas une date de
  fin), SMP avec son hébergeur quand ce n'est pas la plateforme,
  contact technique. Avec deux plateformes, chacune a
  sa carte, titrée par son nom et ses identifiants ;
- les établissements, en une ligne ;
- un dernier cadre replié : détail technique, registres officiels, comment ça marche.

Deux lignes ne s'affichent que lorsqu'elles posent une question : « certificat délivré par
OpenPeppol » seulement quand il ne l'est pas, et l'absence du Peppol Directory seulement quand elle est avérée, en note
sous la carte avec le pourquoi en infobulle. Ce dernier point n'est pas un constat sur l'entreprise
mais sur ce que d'autres outils diront d'elle, donc ni carte ni pastille : la page garde un seul
verdict, et une réserve seulement quand elle change la décision.

Le détail technique garde le reste : identifiants Peppol AP et SMP, processus,
les deux certificats en entier, les zones SML avec leur enregistrement NAPTR brut, leur TTL et
l'état DNSSEC, les doctypes en erreur, et les commandes `dig` et `curl` pour tout refaire à la main.
La mesure complète reste disponible en JSON sur `/api/lookup?q=…`.

**Le dessin.** Cadres blancs très arrondis, ombre douce, beaucoup de vide, une seule encre. Les
traits durs et les ombres décalées de la première version criaient à volume égal sur tous les blocs,
donc rien ne ressortait. Le vert, l'ambre et le rouge ne servent plus qu'au statut : sur un outil de
diagnostic, la couleur doit être un signal.

## Publique et gratuite, et l'outil s'annonce

Le SML **est** du DNS : n'importe quel résolveur répond. Le SMP **doit** être lisible publiquement
et sans authentification, sinon le réseau ne fonctionnerait pas, tout expéditeur devant lire la
fiche du destinataire avant d'envoyer. Interroger le SMP d'un concurrent est le fonctionnement
nominal, c'est ce que fait un point d'accès avant chaque envoi. Zéro clé, zéro compte, zéro quota publié.
La seule limite est la politesse : ce sont les serveurs d'autres opérateurs. Le résolveur DoH est un
choix, pas une dépendance, `dig` donne la même réponse.

Toutes les requêtes portent `User-Agent: PeppolSonar/1.0 (verification de joignabilite Peppol)`.
C'était un en-tête de navigateur, posé à cause d'un 403 de Cloudflare devenu irreproductible, et se
faire passer pour un navigateur sur le serveur d'un autre opérateur n'a aucune raison d'être.
Vérifié avant la bascule sur six SMP et les cinq sources publiques : même code de réponse qu'avec
Chrome, à chaque fois. Qui exploitera l'outil ailleurs qu'en local a intérêt à y ajouter une adresse
de contact.

## Pourquoi un serveur, et aucun JavaScript

Le SML est interrogeable depuis un navigateur (DoH Cloudflare renvoie les NAPTR en JSON avec
`access-control-allow-origin: *`), **mais pas les SMP** : `smp.apifirst.fr` répond 200 sans aucun
en-tête CORS. L'étape SMP doit donc passer par un serveur. Si ça part en production un jour, le
proxy doit résoudre le NAPTR lui-même et ne fetcher que l'hôte retourné par le SML, jamais une URL
fournie par le client (SSRF).

La page est rendue côté serveur et pilotée par un formulaire GET. Le dépliant technique est un
`<details>` natif, l'animation du logo est en CSS, et les boutons sont des liens. Le seul script du
dépôt lit un fichier déposé sur la page `/lot` et le verse dans la zone de texte ; sans lui, on
colle. L'outil marche donc dans un navigateur sans script.

## Ce que l'outil ne peut pas savoir

Trois limites qui tiennent au réseau, pas au code :

1. **La liste des adresses à suffixe n'est jamais garantie complète.** Elle dépend d'un index
   facultatif. On peut dire « voici les formes standard, plus ce que l'index connaît », jamais
   « voici tout ».
2. **Joignable ne veut pas dire que la facture arrivera.** La fiche dit où livrer et ce qui est
   accepté. Ce qui se passe ensuite chez le destinataire ne se lit nulle part publiquement.
3. **La zone historique raconte n'importe quoi**, et n'est plus répliquée. L'outil ne lui accorde
   plus de voix, il se contente de dire ce qu'elle contient encore.

Et trois limites du code :

- l'émetteur des certificats est vérifié contre la PKI Peppol épinglée, mais **pas** la signature
  XML de la réponse, ni la chaîne TLS. L'envoi AS4 réel fait la vérification complète ;
- le SMP dit qui publie l'enregistrement Peppol. L'annuaire PPF reste la vérité sur qui détient la
  ligne : les deux ne bougent pas ensemble ;
- le nom affiché est celui du certificat, pas la marque commerciale : un client de Serensia voit
  `Serensia`, pas le nom de son logiciel.

Pas de limitation de débit ni d'authentification : outil local, pas un service exposé.

## Joignabilité AS4, sur demande

Un lien `?probe=1` appelle la passerelle publiée. Jamais automatique : l'appel touche
l'infrastructure d'un autre opérateur.

La lecture demande de la rigueur. Une réponse HTTP prouve que l'hôte est debout (la nôtre rend 405
sur un GET nu). **Une absence de réponse ne prouve rien** : une passerelle AS4 a le droit d'ignorer
un GET non authentifié, et celle de Tiime le fait. Seul un envoi AS4 signé teste la livraison.

## Pistes écartées

Gardées ici en une ligne chacune, pour qu'elles ne soient pas refaites de zéro.

**La détection de départ** (`watch.js`, qui photographiait une liste de SIREN et signalait les
changements d'une exécution à l'autre). Écartée pour une raison de périmètre, pas de faisabilité :
elle n'a de sens qu'en lui donnant une liste de dossiers clients, donc de la donnée interne, qui
finirait dans l'URL, le cache, les logs et des rafales de requêtes DNS. PeppolSonar reste extérieur
à tout. Une surveillance des départs a du sens, mais comme un autre outil, qui tiendrait sa liste
ailleurs et appellerait `/api/lookup` comme n'importe quel client.

**Nommer la plateforme depuis l'annuaire ouvert des PA** (data.gouv.fr, 148 plateformes). Écarté :
les deux certificats de la réponse SMP donnent la même information, en mieux et sans source
extérieure. Le croisement avait tout de même produit un constat intéressant, sur 101 plateformes
ayant un SIREN exploitable, 89 sont joignables sur Peppol alors que 34 seulement le déclarent.

**Une table matricule PPF vers nom de plateforme.** Écarté : aucune source publique, donc c'était de
la donnée interne recopiée à la main dans l'outil.

**Balayer tous les schémas d'identifiant** pour retrouver un numéro étranger saisi nu. Mesuré,
110 requêtes DNS, aucune collision sur quatre valeurs, mais la liste des schémas serait codée en dur
et le périmètre reste la France.

## Tests

`node --test`, sans réseau ni dépendance. Chaque cas est un bug déjà vécu ou une règle qui
dériverait en silence : le hachage du nom DNS, les formes d'identifiant copiées de notre plateforme, la lecture
d'une balise sous n'importe quel préfixe de namespace, la distinction entre le certificat AP et
celui du SMP dans les deux ordres d'apparition, la fusion et la séparation des identifiants,
« enregistré mais injoignable » distinct d'« absent », l'horloge du certificat, le découpage d'un lot et
l'échappement de son CSV.

Vérifiés par mutation : casser la regex de certificat, changer une forme d'identifiant ou retirer un
garde-fou fait tomber la suite. Le comportement réseau, lui, n'est couvert par aucun test
automatique, il est mesuré à la main.

## Fichiers

- `peppol.js` : formes de participant, zones SML avec résolveur de secours, walk SMP, les deux
  certificats, fusion des identifiants, horloge du certificat, sonde d'endpoint, cache,
  parallélisme, trace des requêtes.
- `peppol.test.js` : les tests de non-régression.
- `saisie.js` : ce qui est tapé vers un identifiant, un nom à chercher, ou une erreur.
- `etablissements.js` : SIREN vers SIRET : la liste d'un côté, les comptes de l'autre, pour que le
  sondage n'attende pas les comptes.
- `suffixes.js` : le dictionnaire de suffixes et la sonde en deux temps, DNS puis fiche.
- `directory.js` : le Peppol Directory, pour les identifiants suffixés et pour savoir si le
  participant y est publié.
- `entreprise.js` : nom et statut depuis recherche-entreprises, et nom vers SIREN.
- `pki.js` : les trois certificats des autorités Peppol G3, épinglés, et la vérification d'émetteur.
- `lot.js` : le lot : texte collé vers lignes, sondage allégé, CSV.
- `render.js` : le HTML, construit côté serveur.
- `server.js` : la page (`/`), `/lot` et `/api/lookup`. Rien d'autre.
- `public/lot.js` : lit le fichier déposé et le verse dans la zone de texte.
- `public/style.css` : la feuille de style.
