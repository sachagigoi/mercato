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

## 3. Les trois chiffres du bas

```
  25 au flux → 11 récupérés → 9 soumis au modèle
  7 déclarations retenues · 2 rejetées · 1 hors périmètre
  taux de rejet 22 %
  340 s de modèle · 38 s par article
```

| Chiffre | Ce qu'il dit |
|---|---|
| **taux de rejet** | Le cadran de qualité. Il se lit sans étiqueter quoi que ce soit, et il monte dès qu'un changement de modèle ou de prompt fait dériver l'extraction. |
| **hors périmètre** | Extraction juste, mais sans club de L1. Compté à part exprès : le mélanger aux rejets fausserait le seul chiffre qui mesure le modèle. |
| **s par article** | Dit si la cadence tient. Au-delà de ~90 s, passer au 3B. |

Un rejet n'est pas un incident : c'est le garde-fou qui fait son travail. Ce
qui doit inquiéter, c'est un taux **durablement** au-dessus de 30 %.

## 4. Comparer deux modèles

Le même flux, deux modèles, sur les mêmes articles :

```bash
npm run extract -- --dry-run --model qwen2.5:7b-instruct-q4_K_M
npm run extract -- --dry-run --model qwen2.5:3b-instruct-q4_K_M
```

Le 3B est ~2,5× plus rapide. S'il tient le taux de rejet du 7B sur de
l'extraction à schéma contraint — champs courts, vocabulaire fermé, phrase à
désigner par son numéro — **prends le 3B et ne repense plus au matériel**. Le
7B reste utile comme arbitre pour étiqueter les cas litigieux.

## 5. Brancher n8n

n8n n'orchestre que l'appel. Toute la logique reste dans le dépôt, sous
`npm test` : le jour où n8n te gêne, un `cron` le remplace sans rien réécrire.

Deux nœuds suffisent :

1. **Schedule Trigger** — toutes les 30 minutes
2. **Execute Command** —
   `cd /home/sacha/mercato && npm run extract -- --out /var/lib/mercato/claims.jsonl`

C'est tout. Commence par lancer le workflow à la main (bouton *Test workflow*)
et regarde la sortie du nœud : si le script marche en ligne de commande, il
marche dans n8n.

> **Le script sait ne pas se répéter.** Il tient un journal des articles déjà
> traités dans `.mercato-seen.json` ; deux passages rapprochés ne relisent pas
> les mêmes brèves. Le journal n'est écrit qu'en fin de passage réussi : une
> interruption fait retenter, elle ne perd rien.

## 6. Ce qui n'est pas encore branché

L'envoi vers Vercel. Aujourd'hui le script écrit un `.jsonl` local — c'est
volontaire : **rien ne part vers la base avant qu'on ait un taux de rejet
regardable**, mesuré sur de vrais articles. La table des déclarations et
l'endpoint `/api/claims` viennent ensuite.

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

**Le montant est vérifié dans la phrase désignée.** C'est le contrôle qui
attrape l'hallucination la plus coûteuse : un chiffre plausible, bien formé, et
absent de l'article. Le nom du joueur, lui, est vérifié sur l'article entier :
exiger le nom dans la citation rejetait des extractions justes, la presse
alternant nom et périphrase (« pour *l'international français* »).

**Le périmètre Ligue 1 est ce qui rend l'inférence CPU tenable.** Mesuré sur un
flux réel : 10 articles sur 25 passent la porte. Le reste n'est jamais présenté
au modèle et ne coûte rien.
