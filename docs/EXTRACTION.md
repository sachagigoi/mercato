# Extraction des déclarations de presse — mode d'emploi

Le worker tourne **sur le mini PC**, là où vit Ollama. Vercel ne peut pas
l'héberger : une fonction serverless ne charge pas un modèle de 5 Go.

---

## 1. Installer

```bash
# Ollama, puis le modèle de référence
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5:7b-instruct-q4_K_M

# Le modèle reste chargé entre deux articles : sans ça on paie ~7 s de
# rechargement à chaque appel, pour ~40 s de travail utile.
sudo systemctl edit ollama
#   [Service]
#   Environment="OLLAMA_KEEP_ALIVE=-1"
#   Environment="OLLAMA_NUM_THREAD=4"    # cœurs PHYSIQUES, pas les threads :
#                                        # l'hyperthreading dégrade llama.cpp
sudo systemctl restart ollama
```

Le dépôt, ensuite. **Node 22.6 minimum** — le worker est en TypeScript exécuté
directement, ce qui demande `--experimental-strip-types` :

```bash
node --version          # doit afficher v22.6 ou plus
git clone https://github.com/sachagigoi/mercato.git && cd mercato

# Tant que la PR n'est pas mergée, le worker vit sur sa branche.
# `git clone` ramène la branche par défaut, qui ne le contient pas.
git checkout claude/maxifoot-claims-pipeline

npm ci
```

## 2. Un premier passage, sans rien écrire

```bash
npm run extract -- --dry-run --limit 3
```

Sortie attendue :

```
source Maxifoot · modèle qwen2.5:7b-instruct-q4_K_M · 0 articles déjà vus
mode sec : rien ne sera écrit

  ▸ Lille : Bouaddi à City pour 100 M€ (officiel)  (38.2 s)
      ✓ Bouaddi · Lille → Manchester City
        100 000 000 € · transfert · officiel
        « C'était attendu, c'est désormais officiel : Ayyoub Bouaddi… »
  ⨯ hors-ligue-1   Chelsea : Delap vers Nottingham pour 52,5 M€
```

**C'est ce qu'il faut regarder en premier.** Pas la vitesse : la justesse des
montants et des clubs.

### Quand une extraction est rejetée

```bash
npm run extract -- --dry-run --verbose --limit 3
```

`--verbose` affiche ce que le modèle a répondu et les phrases qu'il a lues. Sans
lui on sait qu'une extraction a échoué, mais pas pourquoi — et on corrige à
l'aveugle. C'est ce qui manquait au premier passage réel, qui a rejeté 100 % des
extractions sans qu'on puisse voir la sortie du modèle.

## 3. Les trois chiffres du bas

```
  25 au flux → 11 récupérés → 9 soumis au modèle
  7 déclarations retenues · 2 rejetées · 1 hors périmètre
  1 article sans rien en tirer (11 %)
  taux de rejet 22 %
  340 s de modèle · 38 s par article
```

| Chiffre | Ce qu'il dit |
|---|---|
| **taux de rejet** | La **précision**. Il se lit sans étiqueter quoi que ce soit, et il monte dès qu'un changement de modèle ou de consigne fait dériver l'extraction. |
| **sans rien en tirer** | Le **rappel**, autant qu'on peut l'approcher sans étiquetage : un article de L1 dont le modèle n'a tiré ni déclaration ni rejet. Un article peut légitimement ne parler d'aucun mouvement ; c'est la *part* qui alerte. |
| **doublons repliés** | Écritures multiples du même transfert dans un même article. Un signal de qualité à part entière : le 3B en a produit cinq d'affilée. |
| **hors périmètre** | Extraction juste, mais sans club de L1. Compté à part exprès : le mélanger aux rejets fausserait le seul chiffre qui mesure le modèle. |
| **s par article** | Dit si la cadence tient. Au-delà de ~90 s, passer au 3B. |

Un rejet n'est pas un incident : c'est le garde-fou qui fait son travail. Ce
qui doit inquiéter, c'est un taux **durablement** au-dessus de 30 %.

> **Les deux chiffres se lisent ensemble.** Le taux de rejet ne voit que ce que
> le modèle a produit — il est aveugle à ce qu'il a laissé passer. Un passage
> réel a manqué une signature libre à Brest sans qu'aucun chiffre ne bouge :
> ni déclaration, ni rejet, donc rien à voir. D'où la colonne des silences.

> **Huit passages réels ont fait évoluer l'extraction**, chacun sur un défaut
> que le papier n'aurait pas montré.
>
> **Le premier a rejeté 100 %.** Deux causes, toutes deux de
> conception. Le modèle devait rendre un montant *en euros*, donc multiplier
> 100 par un million — ce qu'un 7B rate volontiers, alors qu'un parseur testé
> attendait à côté. Il recopie désormais le montant tel quel et le code le
> convertit. Et le schéma n'offrait aucune façon légale de dire « aucun
> montant » : un décodeur contraint en fabrique alors un. `null` est maintenant
> un type valide, et la consigne dit que l'absence de montant est le cas normal.
>
> **Le deuxième ne rendait aucun club**, et une posture tirée au hasard.
> `fromClub`, `toClub` et `stance` figuraient au schéma mais nulle part dans la
> consigne : un décodeur contraint omet ce qu'on ne lui demande pas, et choisit
> au hasard dans une énumération qu'on ne lui explique pas.
>
> **Le troisième a rejeté une extraction juste.** « Les représentants disposent
> d'un accord avec l'AS Roma » et « l'OL réclame 40 M€ » sont deux phrases
> distinctes ; le schéma n'autorisait qu'un seul indice. `feeSentence` permet
> désormais au montant de citer sa propre phrase.
>
> **Le quatrième a rejeté les deux seules extractions chiffrées**, toutes deux
> justes, et pour la même raison : le modèle normalise la notation du montant
> vers celle du titre. Il a rendu « 40 millions d'euros » là où l'article écrit
> « 40 M€ », et « 9,3 M€ » là où le corps écrit « 9,3 millions d'euros ». La
> comparaison porte désormais sur la **valeur**, avec le même parseur des deux
> côtés, et le montant est **cherché dans tout l'article** au lieu d'être
> vérifié là où le modèle le dit. Le contrôle ne perd rien : une hallucination
> reste introuvable où qu'on la cherche. `feeSentence` n'est plus qu'un
> départage entre deux phrases portant la même valeur.
>
> Le même passage a laissé filer une signature libre sans qu'aucun chiffre ne
> s'en aperçoive — d'où la ligne des silences, et une consigne qui dit
> maintenant qu'un transfert sans montant compte autant qu'un autre.
>
> **Le cinquième n'a rien rejeté du tout — et c'est le pire des cinq.** Zéro
> rejet, mais deux déclarations retenues là où les cinq brèves en portaient
> six. Sur « PSG : Liverpool avance pour Barcola », le modèle a rendu
> `fromClub: null` alors que le PSG est dans le titre : la déclaration est
> sortie du périmètre sans un mot. Le préfiltre connaissait pourtant déjà le
> club — il le calculait sans s'en servir. La consigne annonce désormais les
> clubs de L1 cités, et un garde-fou symétrique refuse un club attribué que
> l'article ne cite pas : pousser le modèle à remplir appelle un contrôle sur
> ce qu'il remplit.
>
> **Le sixième a mesuré ce que ça donne**, sur les mêmes cinq brèves : trois
> déclarations au lieu de deux, plus aucun silence, et Terrier enfin rattrapé.
> Mais `fromClub` reste à null dans les trois cas où le club d'origine est
> étranger — le PSG au titre d'une brève, et le modèle ne le voit pas. « Le
> club qu'il quitte » demande de trancher un sens ; la consigne demande
> désormais « le club où il joue aujourd'hui », question mécanique. Le même
> passage a confirmé que le champ `qualifier` ne sert à rien tel quel : le
> modèle rend `exact` sur « environ 35 millions » comme sur « au moins 25
> millions ». La nuance se lit maintenant dans le texte, juste avant le
> chiffre — déterministe, testé, et gratuit.
>
> **Le septième était le 3B, et il a surtout révélé deux défauts du tableau de
> bord.** Il a rendu cinq entrées pour un seul transfert — une par phrase — et
> les neuf « déclarations retenues » affichées n'étaient qu'environ trois faits.
> Un modèle bavard ne doit pas mieux noter qu'un modèle juste : les doublons
> sont désormais repliés avant d'être comptés, en gardant la déclaration
> chiffrée. Et « Too small: expected string to have >=2 characters », rendu
> quatre fois, ne disait pas s'il s'agissait du joueur ou d'un club : le rejet
> nomme maintenant le champ.
>
> **Le huitième est le premier propre** : cinq brèves, cinq déclarations, aucun
> rejet, aucun silence, aucun doublon. `fromClub` se remplit enfin sur les
> départs vers l'étranger, et les nuances apparaissent (« environ 35 M€ »,
> « minimum 25 M€ »). Le seul défaut restant tenait à un mot : `feeKind: libre`
> sur un joueur sous contrat, dans un texte qui n'emploie jamais le mot. Cette
> nature-là allume une pastille « Libre » sur la carte — une affirmation sur la
> situation contractuelle de quelqu'un. Elle doit désormais être attestée par
> le texte, faute de quoi elle est déclassée en « inconnu ».

## 4. Comparer deux modèles

Le même flux, deux modèles, sur les mêmes articles. **Installe le second
d'abord** — sans ça Ollama rend un 404 par article, et le passage s'arrête :

```bash
ollama pull qwen2.5:3b-instruct-q4_K_M

# Le journal empêche de relire les mêmes brèves : c'est justement ce qu'on veut
# ici. Une comparaison sur deux corpus différents ne compare rien.
rm -f .mercato-seen.json

npm run extract -- --dry-run --model qwen2.5:7b-instruct-q4_K_M --limit 5
rm -f .mercato-seen.json
npm run extract -- --dry-run --model qwen2.5:3b-instruct-q4_K_M --limit 5
```

**Mesuré, et tranché : reste sur le 7B.** Le 3B est ~25 % plus rapide (31 s
contre 42 s par article) et ça ne rachète pas ce qu'il coûte.

| | 7B | 3B |
|---|---|---|
| Montants trouvés | 35 M€ et 25 M€ | **aucun des deux** |
| Doublons | — | 5 entrées pour un seul transfert |
| Sorties hors schéma | — | 4 sur un seul article |
| `feeKind` | juste | « libre » sur une vente à 25 M€ |
| Par article | 42 s | 31 s |

Le montant EST le produit : un modèle qui va vite et ne le trouve pas ne sert
à rien ici. Le 3B a bien un mérite — il a rempli `fromClub` là où le 7B le
laissait à null — mais c'est un point pour la consigne v7, pas pour lui.

> **Une comparaison honnête demande le même corpus.** Ces deux passages
> partagent quatre brèves sur cinq et ne tournaient pas sur la même version de
> consigne. C'est assez pour trancher sur les montants, pas pour départager à
> la marge. D'où le `rm .mercato-seen.json` ci-dessus.

## 5. Brancher n8n

n8n n'orchestre que l'appel. Toute la logique reste dans le dépôt, sous
`npm test` : le jour où n8n te gêne, un `cron` le remplace sans rien réécrire.

Deux nœuds suffisent :

1. **Schedule Trigger** — toutes les 30 minutes
2. **Execute Command** —
   `cd /home/sacha/mercato && npm run extract -- --send`

   (ou `--out /var/lib/mercato/claims.jsonl` pour regarder sans écrire —
   cf. §6)

C'est tout. Commence par lancer le workflow à la main (bouton *Test workflow*)
et regarde la sortie du nœud : si le script marche en ligne de commande, il
marche dans n8n.

> **Le script sait ne pas se répéter.** Il tient un journal des articles déjà
> traités dans `.mercato-seen.json` ; deux passages rapprochés ne relisent pas
> les mêmes brèves. Le journal n'est écrit qu'en fin de passage réussi : une
> interruption fait retenter, elle ne perd rien.

## 6. Envoyer vers la base

**L'envoi se demande, il ne se subit pas.** Sans `--send`, rien ne part — c'est
volontaire : rien n'atterrit en base avant qu'on ait un taux de rejet
regardable, mesuré sur de vrais articles. Le `--out` local reste là pour
regarder sans écrire.

Deux variables suffisent, dans `~/.mercato.env` ou dans l'environnement :

```bash
export MERCATO_URL=https://mercato-two-zeta.vercel.app
export CRON_SECRET=…            # le même jeton porteur que le cron

npm run extract -- --send --limit 5
```

**Le mini PC ne détient aucune clé Supabase.** Il parle à `/api/claims`, qui
valide, résout les clubs contre son propre référentiel, et écrit. Un jeton volé
ici permet d'envoyer des déclarations malformées — que le schéma refuse — pas
de toucher à la base.

L'envoi précède l'écriture du journal : un lot refusé par le serveur est rejoué
au passage suivant, pas marqué comme traité.

| Réponse | Ce qu'elle veut dire |
|---|---|
| `{"articles":3,"declarations":4,"outOfScope":1}` | Écrit. `outOfScope` compte les déclarations justes mais sans club de L1 — jamais une erreur. |
| **401** | `CRON_SECRET` absent ou faux **des deux côtés** : un secret absent sur Vercel ferme l'endpoint au lieu de l'ouvrir. |
| **422** | Lot malformé. C'est une erreur du worker, pas du serveur : inutile de retenter tel quel, la réponse nomme les champs fautifs. |

Rejouer le même lot ne crée rien de neuf : la clé de dédoublonnage porte
l'article, le joueur, la route, le modèle et la version de consigne. Changer de
modèle produit en revanche une ligne **de plus**, comparable à l'ancienne —
c'est ce qui permettra de mesurer un changement de modèle sur du vrai corpus.

## 7. Ce qui n'est pas encore branché

Le **rapprochement** déclaration → piste. Les déclarations s'écrivent, mais
`transfer_id` reste nul : rien n'apparaît encore sur les cartes du feed. C'est
l'étape suivante, et elle mérite son propre passage — décider qu'un article
parle de la rumeur déjà en base, ou d'une nouvelle, n'est pas un détail.

---

## Comment ça marche, en une page

```
flux RSS ─┐
          ├─ préfiltre sur titre + chapô ──→ hors L1 : jamais téléchargé
          │
     article téléchargé
          │
          ├─ préfiltre sur le corps ───────→ hors L1 / vide : jamais soumis
          │
   phrases numérotées ──→ Ollama (schéma contraint) ──→ déclarations brutes
          │                                                    │
          └────────────── garde-fou ───────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
           retenue         rejetée     hors périmètre
```

Trois idées portent tout le reste :

**Le modèle ne produit jamais un fait directement affichable.** Il rend
l'*indice* d'une phrase ; le code en tire la citation. Elle est donc exacte par
construction — aucune vérification de sous-chaîne ne peut échouer sur une
apostrophe — et ça coûte deux tokens au lieu de quarante.

**Le montant est cherché dans l'article, et comparé en valeur.** C'est le
contrôle qui attrape l'hallucination la plus coûteuse : un chiffre plausible,
bien formé, et absent de l'article. Il a d'abord porté sur la phrase que le
modèle désigne, et sur les caractères — il ne rejetait alors que des
extractions justes. Le nom du joueur suit la même règle : vérifié sur l'article
entier, parce que la presse alterne nom et périphrase (« pour *l'international
français* »).

**Le périmètre Ligue 1 est ce qui rend l'inférence CPU tenable.** Mesuré sur un
flux réel : 10 articles sur 25 passent la porte. Le reste n'est jamais présenté
au modèle et ne coûte rien.
