# Mercato — Spécifications techniques MVP

> Feed temps réel de transferts et rumeurs football. Next.js 16 (App Router) · Supabase · Tailwind v4.
> Document de référence unique pour le MVP.

**État : les 6 phases sont livrées et le produit est en ligne sur
<https://mercato-two-zeta.vercel.app>, ingestion comprise. Restent les deux
secrets GitHub du workflow et la validation du Realtime.**

> **Reprise de session — à lire en premier.** Tout est poussé sur
> `claude/mercato-webapp-mvp-agsll7` — branche par défaut du dépôt, et branche
> de production du projet Vercel. L'état du déploiement et la marche à suivre
> sont en §12.

**Historique :** Base en ligne et vérifiée, carte et grille en place, filtres et
Realtime branchés, pipeline d'ingestion idempotent et route cron protégée — cf. §11.

**En cours, au-delà du MVP :** le pipeline multi-sources qui capture le montant
d'un transfert dans la prose de presse — §13.

---

## 0. Décisions d'architecture (et pourquoi)

Quatre points du brief initial se heurtent à une contrainte vérifiée. Trois donnent lieu à un
écart ; le quatrième — le détourage — est tenu tel quel, au prix d'une journée assumée.

### 0.1 Le Rumourometer ne vient pas de l'API Transfermarkt open-source

`felipeall/transfermarkt-api` (le microservice Docker/FastAPI de référence) expose des joueurs,
clubs, compétitions, valeurs marchandes, historiques de transferts et blessures — **mais aucun
endpoint rumeurs**, donc aucune probabilité de transfert.

La donnée existe pourtant bien sur Transfermarkt : la page `/statistik/aktuellegeruechte` liste les
rumeurs avec une colonne *Wechselwahrscheinlichkeit* (probabilité de transfert), triable via
`/sort/wahrscheinlichkeit.desc`. C'est exactement le Rumourometer.

**Décision** : on scrape cette page nous-mêmes (une page, une requête, un parse Cheerio) au lieu de
déployer le microservice. Le microservice reste une option Phase 5 si on a besoin de données
joueur/club profondes.

**Conséquence : on supprime Render du MVP.** Un service de moins à déployer, monitorer et payer. Le
free tier Render s'endort après 15 min d'inactivité (~50 s de cold start) — avec un cron toutes les
30 min, *chaque* appel aurait payé le réveil.

### 0.2 API-Football = 100 requêtes/jour, remise à zéro à 00:00 UTC

Le plan gratuit plafonne à 100 requêtes/jour. Un feed avec 40 cartes × 3 visuels = 120 appels : le
quota saute avant même le premier affichage.

**Décision** : les visuels ne sont **jamais** résolus au moment du rendu. Une table `media_cache`
mappe `nom normalisé → URL d'image` une fois pour toutes. Un club vu une fois ne coûte plus rien.
En régime permanent, l'ingestion consomme ~5-10 appels/jour (nouveaux joueurs uniquement), et le
budget est protégé par un compteur journalier qui coupe à 80 appels.

### 0.3 Les photos API-Football ne sont pas détourées

`media.api-sports.io/football/players/{id}.png` renvoie un portrait carré sur fond plein, pas un
découpage transparent type FUT. Le brief demande « tête détourée ».

**Décision (arbitrage produit) : on fait le vrai détourage, dès le MVP.** Le rendu carte FIFA est
l'identité du produit ; le simuler avec un masque circulaire aurait été une économie au mauvais
endroit. Coût assumé : +1 jour et un worker de plus. Architecture complète en §6.

Le masque circulaire n'est pas abandonné pour autant — il devient le **deuxième niveau** d'une
chaîne de repli à trois étages (§6.4). À tout instant le feed contient des lignes dans les trois
états, donc la carte doit être belle dans les trois.

### 0.4 Le schéma initial n'est pas ré-exécutable

`transfers` tel que spécifié n'a aucune clé naturelle. Deuxième passage du script d'ingestion =
doublons dans le feed. C'est le bug numéro un de tout pipeline de scraping.

**Décision** : ajout de `external_id text unique` + `upsert on conflict`. Détaillé en §2.

---

## 1. Stack

| Couche | Choix | Note |
|---|---|---|
| Framework | Next.js 16, App Router, TypeScript strict | RSC pour le fetch initial |
| Styling | Tailwind CSS v4 (config CSS-first `@theme`) | dark-only, pas de toggle |
| DB / Realtime | Supabase (Postgres 17, région `eu-west-3`) | projet dédié, plan gratuit (0 €/mois) |
| Rumeurs | Scraper Cheerio → `transfermarkt.us/statistik/aktuellegeruechte` | Route Handler, pas de service externe |
| Visuels | API-Football (api-sports.io) | cache obligatoire, cf. §0.2 |
| Détourage | `rembg` (`isnet-general-use`) sur GitHub Actions | worker batch gratuit, cf. §6 |
| Stockage images | Supabase Storage, bucket public `cutouts` | 512 Ko/fichier, WebP + PNG |
| Hébergement | Vercel | Cron Jobs pour l'ingestion |
| Fonts | Geist Sans + Geist Mono (`next/font`) | `tabular-nums` pour les montants |

**Aucune librairie de composants** (pas de shadcn, pas de Radix). Six composants au total, tous
maîtrisés. Une seule dépendance runtime hors stack : `cheerio`. Le worker de détourage est en
Python et vit hors du bundle applicatif — il ne pèse rien sur le déploiement Vercel.

---

## 2. Schéma de base de données

### 2.1 Table `transfers`

```sql
create type public.transfer_type as enum ('TRANSFER', 'RUMOUR', 'EXTENSION');

create table public.transfers (
  id                  uuid primary key default gen_random_uuid(),

  -- Identité / idempotence
  external_id         text not null unique,

  -- Joueur
  player_name         text not null,
  player_photo        text,              -- URL source (API-Football / Transfermarkt)
  player_cutout       text,              -- URL Supabase Storage du PNG détouré
  nationality_code    text,              -- ISO 3166-1 alpha-2 minuscule ('fr', 'br')

  -- Clubs
  from_club_name      text,
  from_club_logo      text,
  to_club_name        text,
  to_club_logo        text,

  -- Clubs (suite) : le marché visé
  to_country_code     text,              -- 'pl', ou 'gb-eng' pour les nations britanniques
  to_country_name     text,              -- francisé à l'ingestion : 'Pologne'
  to_competition      text,              -- 'Ekstraklasa', tel que nommé par la source

  -- Deal
  transfer_fee        text,              -- libellé d'affichage : '45 M€', 'Prêt', 'Libre'
  fee_value_eur       bigint,            -- valeur numérique ou null ; tri et filtres
  market_value_eur    bigint,            -- estimation, PAS un prix convenu
  market_value_label  text,              -- '220 M€', francisé à l'ingestion
  market_value_fetched_at timestamptz,   -- null = jamais lue ; file d'attente et péremption
  tm_player_id        text,              -- clé de regroupement de la résolution des valeurs
  type                public.transfer_type not null,
  probability_score   smallint check (probability_score between 0 and 100),
  previous_probability smallint check (previous_probability between 0 and 100),
  status_badge        text,              -- libellé d'affichage uniquement, cf. §4.3

  -- Provenance
  source              text,
  source_url          text,

  -- Modération / temps
  is_published        boolean not null default true,
  published_at        timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
```

### 2.2 Justification des colonnes ajoutées

| Colonne | Problème résolu |
|---|---|
| `external_id` | Idempotence. Format : `tm:rumour:{tm_player_id}:{tm_to_club_id}`, ou `manual:{slug}` pour le seed. Sans elle, chaque run du cron duplique le feed. |
| `fee_value_eur` | `transfer_fee` est du texte : impossible de trier ou filtrer dessus. On garde le texte pour l'affichage, on parse une fois à l'ingestion pour la logique. Débloque « Top deals » sans migration. |
| `previous_probability` | La flèche de tendance ↑↓ sur la jauge. Une rumeur qui passe de 45 % à 78 % est l'information la plus intéressante du produit ; sans mémoire de la valeur précédente elle est invisible. Une colonne, pas une table d'historique. |
| `published_at` | Date de l'info, distincte de `created_at` (date d'insertion). Sans ça, un backfill de 500 vieilles rumeurs remonte en tête de feed. **Le tri du feed se fait sur `published_at`.** |
| `is_published` | Interrupteur de modération. Avec de la donnée scrapée, il faut pouvoir masquer une ligne sans la supprimer. |
| `nationality_code` | ISO plutôt qu'emoji : l'emoji se dérive côté client (arithmétique regional-indicator, §4.4). Permet de passer à des drapeaux SVG plus tard sans toucher à la base. |
| `source_url` | Traçabilité. Une carte non cliquable vers sa source n'est pas crédible sur un produit d'actu. |
| `market_value_*` | La page des rumeurs n'affiche **aucun** montant, et c'est logique : sans accord, il n'y a pas de prix. Le seul chiffre honnête est la valeur de marché du joueur, lue sur sa fiche. Elle est stockée à part de `transfer_fee` parce qu'une estimation et un prix convenu ne disent pas la même chose — les confondre ferait lire « 45 M€ » comme un transfert bouclé. La carte annonce lequel des deux elle montre. |
| `tm_player_id` | La valeur appartient au joueur, pas à la rumeur. Regrouper dessus fait qu'un joueur cité dans trois rumeurs ne coûte qu'une requête, et que la valeur arrive d'un coup sur les trois cartes. |
| `to_country_*`, `to_competition` | Le filtre pays (§4.6). Un feed mondial de rumeurs noie ce qu'on cherche, et le pays du club **acheteur** est la coupe la plus naturelle — on suit un championnat avant de suivre une catégorie. C'est bien la destination et non la nationalité du joueur : ce qu'on veut savoir, c'est où la rumeur pourrait aboutir. |
| `player_cutout` | Séparée de `player_photo` plutôt que de l'écraser. Le détourage est asynchrone et faillible : garder la source intacte permet de retomber dessus, et de rejouer le worker après un changement de modèle sans avoir rien perdu. |

### 2.3 Index

```sql
create index transfers_feed_idx     on public.transfers (published_at desc) where is_published;
create index transfers_type_idx     on public.transfers (type, published_at desc) where is_published;
create index transfers_hot_idx      on public.transfers (probability_score desc)
  where is_published and type = 'RUMOUR';
```

`transfers_country_idx (to_country_code, published_at desc) where is_published` s'ajoute pour la
seconde rangée de filtres, et `transfers_market_value_queue_idx (market_value_fetched_at nulls
first) where tm_player_id is not null` sert de file d'attente à la résolution des valeurs.

Les trois premiers index couvrent exactement les quatre filtres de type de la barre. Index partiels : `is_published`
étant vrai dans ~99 % des cas, ils restent petits.

### 2.4 `updated_at` automatique

```sql
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger transfers_touch_updated_at
  before update on public.transfers
  for each row execute function public.touch_updated_at();
```

### 2.5 Table `media_cache`

```sql
create table public.media_cache (
  id               bigint generated always as identity primary key,
  kind             text not null check (kind in ('club', 'player')),
  name_normalized  text not null,       -- minuscule, sans accents ni ponctuation
  af_id            integer,             -- id API-Football, null si non trouvé
  image_url        text,                -- URL source telle que renvoyée par l'API

  -- Pipeline de détourage (joueurs uniquement)
  cutout_url       text,
  cutout_status    text not null default 'pending'
                     check (cutout_status in ('pending','done','failed','skipped')),
  cutout_attempts  smallint not null default 0,

  miss_count       smallint not null default 0,
  fetched_at       timestamptz not null default now(),
  unique (kind, name_normalized)
);

-- File d'attente du worker de détourage
create index media_cache_cutout_queue_idx on public.media_cache (fetched_at)
  where kind = 'player' and cutout_status = 'pending' and cutout_attempts < 3;
```

C'est cette table qui rend le quota de 100 req/jour vivable. `miss_count` évite de re-brûler du
quota sur un club introuvable à chaque run : au-delà de 3 échecs, on n'interroge plus et le front
tombe sur le fallback initiales (§4.5).

La table sert aussi de **file d'attente du worker de détourage** (§6) : le portrait est traité une
fois par joueur, pas une fois par rumeur — un joueur cité dans trois rumeurs ne coûte qu'un seul
passage du modèle.

### 2.6 RLS et Realtime

```sql
alter table public.transfers  enable row level security;
alter table public.media_cache enable row level security;

-- Lecture publique des seules lignes publiées.
create policy "transfers_public_read" on public.transfers
  for select to anon, authenticated using (is_published);

-- Aucune policy d'écriture : seul service_role écrit (il contourne RLS).
-- media_cache : aucune policy du tout -> invisible côté client. Volontaire.

alter table public.transfers replica identity full;
alter publication supabase_realtime add table public.transfers;

-- Bucket public des portraits détourés. Écriture réservée à service_role.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cutouts', 'cutouts', true, 524288, array['image/png','image/webp']);

create policy "cutouts_public_read" on storage.objects
  for select to anon, authenticated using (bucket_id = 'cutouts');
```

Deux points non négociables :

- **`replica identity full`** — sans elle, les payloads `UPDATE` de Realtime n'embarquent que la
  clé primaire dans `old_record`, et l'animation de variation de jauge n'a rien à comparer.
- **Realtime respecte RLS** avec la clé `anon`. Une ligne dépubliée cesse d'émettre — comportement
  voulu, mais il faut le savoir : dépublier n'envoie pas d'événement de suppression au client déjà
  connecté, il faut un refetch.


### 2.7 Tables `press_articles` et `declarations`

La frontière est nette et elle porte tout le pipeline multi-sources (§13) :
`transfers` porte l'état **courant** d'une piste, celui qu'affiche le feed ;
`declarations` porte les **observations** qui l'ont fait bouger, une par source
et par passage. La première s'écrase, la seconde s'empile.

C'est ce qui rend le produit défendable. Quand une carte affiche « 50 M€ », on
peut montrer l'article, la phrase exacte, le modèle et la version de consigne
qui l'ont produite. Un montant écrasé au fil des sources ne saurait rien
répondre.

```sql
create type public.claim_stance    as enum ('rumeur','discussions','accord','officiel','dementi');
create type public.claim_fee_kind  as enum ('transfert','pret','pret_avec_option','clause','libre','inconnu');
create type public.claim_qualifier as enum ('exact','environ','minimum','maximum');

create table public.press_articles (
  id, source, source_tier, guid unique, url, title,
  published_at, first_seen_at, last_extracted_at
);

create table public.declarations (
  id, claim_key unique, article_id -> press_articles, transfer_id -> transfers,
  player_name, player_normalized,
  from_club_name, from_club_key, to_club_name, to_club_key,
  fee_eur, fee_label, fee_kind, qualifier, bonus_eur, stance,
  quote, fee_quote, player_in_quote,
  model, prompt_version, published_at, created_at
);
```

| Choix | Pourquoi |
|---|---|
| `model` et `prompt_version` **sur la déclaration**, pas sur l'article | L'article est un fait du monde, l'extraction un fait de notre pipeline. Rejouer un corpus avec un autre modèle ne doit pas réécrire la provenance. |
| Les deux dans `claim_key` | Un second modèle produit une ligne **comparable**, pas un écrasement. Sans ça, aucun banc d'essai ne peut mesurer un changement de modèle sur de vrais articles. |
| Le libellé brut **et** la clé résolue | Le brut permet de rejouer une résolution ratée. Le perdre rendrait toute correction du référentiel inapplicable au passé. |
| `transfer_id` nul par défaut | Une déclaration existe indépendamment de ce qu'elle enrichit, et peut arriver **avant** la rumeur qui la concerne. Le rapprochement (§13.7) la rattache ensuite, à la réception puis après chaque moisson. |
| `quote` obligatoire | Sans citation, une déclaration n'est qu'une affirmation. C'est ce champ qui autorise à afficher un montant sans demander qu'on nous croie. |

Index : `declarations_pending_idx` (file du rapprochement, `where transfer_id is
null`), `declarations_player_idx` (le rapprochement part du nom), et
`declarations_transfer_idx` (l'historique d'une piste, `where transfer_id is not
null`). Les trois sont partiels ou composites pour la même raison que ceux de
`transfers` : ils sont taillés sur les requêtes qui existent, pas sur celles
qu'on imagine.

RLS activée, **aucune policy** — comme `media_cache`. Les deux tables portent de
la matière de travail, pas du contenu publiable ; seul `service_role` y accède.
Le feed lit `transfers`, qui reste la seule table exposée.

---

## 3. Arborescence

```
app/
  layout.tsx                    # thème sombre, fonts, metadata, OG
  page.tsx                      # RSC : fetch initial 60 lignes
  globals.css                   # @theme Tailwind v4 + tokens
  api/cron/ingest/route.ts      # runner d'ingestion (GET pour Vercel Cron, POST manuel)
  api/claims/route.ts           # réception des déclarations du mini PC (§13)
  preview/page.tsx              # banc de rendu des composants (§4.8)
  preview/feed/page.tsx         # banc d'interaction du feed (§4.8)
components/
  MercatoFeed.tsx               # 'use client' — état, realtime, filtres
  FilterBar.tsx                 # 'use client' — 4 onglets
  MercatoCard.tsx               # présentationnel pur, zéro état
  ProbabilityGauge.tsx          # jauge néon + tendance
  StatusBadge.tsx               # pastille colorée
  Crest.tsx                     # logo club, fallback initiales
  PlayerPortrait.tsx            # portrait, chaîne de repli à 3 niveaux
lib/
  supabase/client.ts            # navigateur (anon)
  supabase/server.ts            # RSC (anon)
  supabase/admin.ts             # service_role — import 'server-only' obligatoire
  ingest.ts                     # validation, dédoublonnage, normalisation, upsert
  ingest.test.ts                # 14 tests, dont les 3 exécutions sans doublon
  format.test.ts                # 19 tests, dont les parseurs de montants et de valeurs
  supabase/store.ts             # implémentation Supabase des dépôts d'ingestion
  sources/fixtures.ts           # source de démonstration (Phase 3)
  sources/transfermarkt.ts      # scraper rumeurs + fiche joueur (valeur de marché)
  sources/transfermarkt.test.ts # 16 tests contre deux pages réelles enregistrées
  sources/apifootball.ts        # résolution visuels + cache + budget
  format.ts                     # parsing montants, emoji drapeau, temps relatif
  accent.ts                     # accentOf() + map de classes littérales
  feed.ts                       # mergeRows(), maxCreatedAt() — logique pure
  feed.test.ts                  # 13 tests node:test sur la fusion et les filtres
  filters.ts                    # filtres de type et de pays, seuil « chaud »
  filters.test.ts               # 12 tests sur la composition des deux axes
  countries.ts                  # nom de pays source -> { code drapeau, nom français }
  countries.test.ts             # 8 tests, dont les nations sans code ISO
  market-value.ts               # résolution des valeurs, une fiche par joueur
  market-value.test.ts          # 7 tests, dont l'arrêt après trois échecs
  fixtures.ts                   # jeu de cas limites du banc de rendu
  declarations.ts               # point de passage unique vers declarations (§13)
  reconcile.ts                  # rapprochement déclaration -> piste (§13.7)
  reconcile.test.ts             # 21 tests, dont les deux erreurs qui ne se valent pas
  declarations.test.ts          # 11 tests, dont l'idempotence et la comparaison de modèles
  articles.ts                   # contrat commun à toutes les sources de presse
  referential.ts                # les 18 clubs de L1, alias de presse compris
  sources/maxifoot.ts           # flux RSS + corps d'article (ISO-8859-1)
  sources/maxifoot.test.ts      # 14 tests contre 5 brèves réellement enregistrées
  extract/prefilter.ts          # porte L1, montants en prose, phrases numérotées
  extract/claims.ts             # schéma contraint + garde-fou
  extract/ollama.ts             # client Ollama, consigne versionnée
  extract/run.ts                # le passage complet, source -> déclarations
  types.ts                      # types générés depuis Supabase
public/demo/                    # gabarits de portrait (Phase 1)
scripts/
  cutout.py                     # worker de détourage (hors bundle Next.js)
  extract.ts                    # worker d'extraction, tourne sur le mini PC (§13)
  requirements.txt              # rembg, pillow, httpx, supabase
.github/workflows/
  cutout.yml                    # cron GitHub Actions, */20
docs/
  SPEC.md                       # ce document
  EXTRACTION.md                 # mode d'emploi du worker du mini PC
supabase/
  migrations/                   # SQL versionné
  seed.sql                      # 24 lignes de démo
```

---

## 4. Front-end

### 4.1 Découpage serveur / client

`app/page.tsx` est un **Server Component** : il fetch les 60 lignes initiales via le client anon
côté serveur. Bénéfice : HTML complet au premier octet, feed indexable, pas de spinner.

`MercatoFeed.tsx` est un **Client Component** qui reçoit ces lignes en props et prend la main pour
le realtime et les filtres. Les filtres opèrent **en mémoire** sur le jeu chargé — aucun aller-retour
réseau au clic. Sous 1 000 lignes c'est instantané et ça supprime tout état de chargement.

### 4.2 Realtime — les trois pièges à traiter explicitement

1. **La fenêtre de course.** Entre le fetch RSC et l'établissement de l'abonnement, les lignes
   insérées sont perdues à jamais. **Correctif obligatoire** : dans le callback `status === 'SUBSCRIBED'`,
   refetch les lignes où `created_at > maxCreatedAt` du jeu initial, puis merge.
2. **Les doublons.** Realtime peut rejouer un événement. Tout merge passe par une `Map` indexée sur
   `id` — jamais un `[...prev, nouveau]` nu.
3. **La croissance mémoire.** Onglet ouvert 8 h = tableau qui gonfle sans borne. On tronque à 200
   éléments après chaque merge.

Ces trois comportements sont couverts par des tests unitaires sur `lib/feed.ts` — c'est la seule
partie du Realtime qui se teste sans base joignable, et c'est celle qui contient les bugs.

**Indicateur de connexion.** La barre de filtres affiche l'état de l'abonnement : *En direct*,
*Connexion*, ou *Différé 60 s*. Sur échec ou coupure (`CHANNEL_ERROR`, `TIMED_OUT`, `CLOSED`), on
bascule sur une relecture complète toutes les 60 s — le repli prévu au §10. Un feed figé sans le
dire est pire qu'un feed en différé qui l'annonce.

Gestion des événements :

| Événement | Comportement |
|---|---|
| `INSERT` | Prepend + flash d'entrée (`animate-in`, 400 ms). Respecte `prefers-reduced-motion`. |
| `UPDATE` | Remplacement en place. Si `probability_score` change, la jauge s'anime vers la nouvelle valeur et la flèche de tendance apparaît 5 s. |
| `DELETE` | Retrait de la Map. |

### 4.3 Couleur des badges — dérivée, pas stockée

Le brief fait porter la couleur par `status_badge` (texte libre). Le front devrait alors matcher des
chaînes : `"Officialisé"` vert, mais `"Officiel"` ou `"Signé"` tomberaient dans le cas par défaut.
Une faute de frappe à l'ingestion casse le rendu.

**La couleur est une fonction pure de `type` + `probability_score`.** `status_badge` ne porte que le
libellé affiché.

```ts
type Accent = 'emerald' | 'amber' | 'sky' | 'slate';

function accentOf(t: TransferType, p: number | null): Accent {
  if (t === 'TRANSFER')  return 'emerald';   // officialisé
  if (t === 'EXTENSION') return 'sky';       // prolongation
  if (t === 'RUMOUR')    return (p ?? 0) >= 70 ? 'amber' : 'slate';
  return 'slate';
}
```

Effet de bord bienvenu : une rumeur tiède est visuellement grise, une rumeur chaude s'allume en
ambre. La température du feed se lit d'un coup d'œil, sans lire un mot.

> **Contrainte Tailwind** : les classes ne peuvent pas être construites dynamiquement
> (`bg-${accent}-400` est purgé au build). On utilise une **map statique** `accent → classes
> littérales`, dans un seul fichier.

### 4.4 Drapeau depuis le code pays

Deux formes, parce que le football ne se joue pas en pays ISO. Un code alpha-2 passe par
l'arithmétique regional-indicator ; les nations britanniques — `gb-eng`, `gb-sct`, `gb-wls` — n'ont
pas de code ISO 3166-1 et demandent une séquence de balises sur le drapeau noir. Sans ce second cas,
la Premier League s'afficherait sous l'Union Jack, ou sans drapeau du tout.

```ts
flagEmoji('fr')      // 🇫🇷
flagEmoji('gb-eng')  // drapeau anglais, via U+1F3F4 + balises + U+E007F
flagEmoji('fra')     // '' — ni l'un ni l'autre
```

La correspondance nom de pays -> `{ code, nom français }` vit dans `lib/countries.ts` et s'applique
**à l'ingestion**, jamais au rendu : même règle que `parseFee`. Un pays absent de la table garde son
nom source et perd seulement son drapeau — la puce de filtre reste lisible au lieu de disparaître.

### 4.5 `MercatoCard` — anatomie

```
┌──────────────────────────────────────────────────┐
│  [logo]  OM   ──────➔──────   PSG  [logo]        │  header, h-16, séparateur bas
├──────────────────────────────────────────────────┤
│   ╭────╮   RAYAN CHERKI  🇫🇷                      │  body
│   │tête│   ● Piste chaude   🇫🇷 Ligue 1           │  badge = accentOf() + marché visé
│   ╰────╯   45 M€                                 │  text-2xl font-bold tabular-nums
│            VALEUR ESTIMÉE                        │  ce que le chiffre est vraiment
│                                                  │
│   ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░  78%  ↑12                   │  jauge néon + tendance
├──────────────────────────────────────────────────┤
│  Fabrizio Romano · il y a 2 h              ↗     │  footer, text-[11px]
└──────────────────────────────────────────────────┘
```

Détails d'implémentation :

- **Carte** : `bg-slate-900/60 border border-slate-800 rounded-2xl backdrop-blur-sm`, hover
  `border-slate-700` + `translate-y-[-2px]`, transition 200 ms.
- **Tête joueur** : cadre de 88 px, rendu selon l'état du portrait (§6.4). Détouré : image à fond
  perdu, alignée sur le bas du cadre, débordant légèrement en haut — c'est ce débord qui fait la
  carte FIFA. Non détouré : masque circulaire `rounded-full ring-2 ring-slate-800`. Dans les deux
  cas, halo radial en couleur d'accent derrière (`absolute inset-0 blur-2xl opacity-25`).
- **Logos clubs** : 32 px, `next/image`. `Crest.tsx` gère l'échec : si `logo` est nul ou l'image en
  erreur, on rend un cercle `bg-slate-800` avec les initiales du club. **Un logo tiers casse un
  jour ou l'autre ; le fallback n'est pas optionnel.**
- **Flèche** : SVG inline, dégradé du club vendeur vers l'acheteur, animation `translateX` légère
  au hover de la carte.
- **Jauge** : masquée si `type !== 'RUMOUR'` (une prolongation officielle à 100 % est du bruit).
  Barre `h-1.5 rounded-full bg-slate-800`, remplissage en dégradé + `shadow-[0_0_10px_-1px]` en
  couleur d'accent, `transition-[width] duration-700 ease-out`.
- **Tendance** : `probability_score - previous_probability`, affichée si |delta| ≥ 3.
- **Montant** : deux chiffres possibles, qui ne disent pas la même chose. Un prix convenu
  (`transfer_fee`) est un fait ; une valeur de marché (`market_value_label`) est une estimation. Le
  prix l'emporte quand il existe, et **dans les deux cas la carte dit lequel elle montre** —
  « 45 M€ » posé nu sur une rumeur laisserait croire à un accord trouvé. Rien n'est affiché quand on
  n'a ni l'un ni l'autre : un tiret en gros gras ressemble à un bug, pas à une absence.
- **Marché visé** : `to_competition` avec le drapeau de `to_country_code`, à côté du badge de
  statut plutôt qu'en pied de carte — c'est la même nature d'information, de quoi situer la rumeur
  d'un coup d'œil, et c'est ce que la seconde rangée de filtres découpe.
- **Accessibilité** : la carte entière est un `<a>` vers `source_url` si présent. Jauge en
  `role="progressbar"` avec `aria-valuenow`. Contrastes ≥ 4.5:1 sur le fond `#0B0F17`.

### 4.6 Grille et filtres

```tsx
<div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
```

Barre de filtres, quatre onglets, l'actif porte un `layoutId`-like underline en CSS pur :

| Onglet | Prédicat |
|---|---|
| Tous | `true` |
| Officialisés | `type === 'TRANSFER'` |
| Rumeurs chaudes | `type === 'RUMOUR' && (probability_score ?? 0) >= 70` |
| Prolongations | `type === 'EXTENSION'` |

Une **seconde rangée** filtre par pays du club acheteur. Elle est volontairement plus discrète :
le type d'info est la coupe principale, le pays une précision, et deux rangées de même poids
donneraient une barre collante qui pèse plus lourd que le feed qu'elle filtre. Elle disparaît quand
il n'y a qu'un seul pays à proposer.

Les puces ne viennent pas d'une nomenclature figée mais des lignes chargées, les plus fournies
d'abord. Deux jeux les alimentent, et c'est le point délicat :

| | Source | Pourquoi |
|---|---|---|
| **Quelles puces existent** | le feed entier | Les dériver du type sélectionné faisait disparaître la puce active au premier changement d'onglet, emportant la sélection avec elle. Une rangée qui se réorganise sous le doigt de qui l'utilise n'est pas un filtre. |
| **Leurs compteurs** | le type sélectionné | Le nombre affiché doit être exactement ce que le clic va montrer. |

Les deux axes se comptent donc l'un dans l'autre : les types sur le pays choisi, les pays sur le
type choisi. Une puce à zéro est masquée — sauf la puce active, qui reste visible pour qu'on puisse
la désélectionner et pour que l'état vide sache de quel pays il parle.

Les lignes que la source ne situe pas ne créent aucune puce : elles restent visibles sous « Tous
les pays », ce qui est exactement ce que la puce annonce.

Chaque onglet affiche son compteur. Les deux filtres actifs sont reflétés dans l'URL (`?f=hot&p=fr`)
via `history.replaceState` : « les rumeurs chaudes en Ligue 1 » est justement le genre de lien qu'on
envoie à quelqu'un.

État vide par filtre (« Aucune rumeur chaude pour l'instant »), et nommant le pays dès qu'un pays
est choisi — « Aucune rumeur chaude » laisserait croire que le feed entier est froid alors que
seule l'Espagne l'est. Jamais une grille blanche.

### 4.7 Tokens de design (`globals.css`, Tailwind v4)

```css
@theme {
  --color-bg:      #0b0f17;
  --color-surface: #0f172a;
  --color-line:    #1e293b;
  --color-official:   #34d399;  /* emerald-400 */
  --color-rumour:     #fbbf24;  /* amber-400   */
  --color-extension:  #38bdf8;  /* sky-400     */
}
```

Dark natif : `<html class="dark">` en dur dans `layout.tsx`, plus `color-scheme: dark` pour que les
scrollbars et contrôles natifs suivent. Pas de toggle clair au MVP.

### 4.8 Banc de rendu (`/preview`)

Une page hors feed qui rend `MercatoCard` contre des fixtures locales, sans jamais toucher la base.
Elle couvre les états qu'un feed nominal ne montre pas et qui sont pourtant ceux qui cassent une
carte en production :

- les trois niveaux de portrait (§6.4), côte à côte ;
- les quatre accents, dont la rumeur tiède qui doit retomber en gris ;
- les bornes de la jauge, 0 % et 100 % ;
- un nom de joueur et des noms de clubs qui débordent ;
- une ligne réduite au strict minimum, tout le reste étant nul ;
- la grille réelle, pour vérifier que les pieds de carte s'alignent quand des cartes de hauteurs
  différentes tombent sur la même ligne.

C'est le point de retour après chaque retouche du design, et le seul endroit où l'on peut juger la
carte sans dépendre de la disponibilité de la base.

---

## 5. Ingestion

### 5.1 Contrat de `lib/ingest.ts`

Le brief demande un helper qui « formate la donnée entrante avant insertion ». On en fait le point
de passage **unique** vers la base : aucun autre fichier n'écrit dans `transfers`.

```ts
// Donnée brute, quelle que soit la source.
export interface RawTransferInput {
  externalId: string;
  tmPlayerId?: string;          // clé de regroupement de la résolution des valeurs
  playerName: string;
  nationalityCode?: string;
  fromClub?: string;
  toClub?: string;
  toCountry?: string;           // langue de la source : 'Poland' ; francisé par normalize()
  toCompetition?: string;       // 'Ekstraklasa'
  fee?: string;                 // texte brut : '€45.00m', 'loan transfer', 'free'
  type: TransferType;
  probability?: number;
  statusLabel?: string;
  source?: string;
  sourceUrl?: string;
  publishedAt?: Date;
}

/** Normalise, résout les visuels (cache d'abord), valide. Ne touche pas la base. */
export function normalize(raw: RawTransferInput): Promise<TransferRow>;

/** Upsert idempotent par lots de 50. Retourne un compte inséré/mis à jour. */
export function ingest(rows: RawTransferInput[]): Promise<IngestReport>;
```

### 5.2 Étapes du pipeline

1. **Validation** — schéma Zod. Une ligne invalide est *skippée et loguée*, elle ne fait jamais
   échouer le lot entier.
2. **Normalisation des montants** — `'€45.00m' → { fee_value_eur: 45_000_000, transfer_fee: '45 M€' }`.
   Cas à couvrir : `free transfer` → `'Libre'` / `0` ; `loan` → `'Prêt'` / `null` ;
   `?` ou vide → `'—'` / `null`. Le texte affiché est toujours francisé à l'ingestion, jamais au rendu.
3. **Résolution des visuels** — `media_cache` d'abord ; appel API-Football uniquement sur miss, et
   uniquement si le compteur journalier < 80. Au-delà, la ligne est insérée sans visuel : **une carte
   sans logo vaut mieux qu'une carte absente.**
4. **Calcul de la tendance** — avant l'upsert, lecture des `probability_score` courants pour les
   `external_id` du lot ; l'ancienne valeur part dans `previous_probability`.

   **On ne déplace le repère que si la probabilité a bougé.** Réécrire
   `previous = current` à chaque passage effacerait la tendance dès la première moisson sans
   changement : la flèche ↑12 disparaîtrait vingt minutes après être apparue, alors que
   l'information est toujours vraie.

4 bis. **Stabilité de `published_at`** — la date n'est prise de la source que si elle en fournit
   une ; sinon on reprend celle déjà en base. Sans cette règle, chaque passage du cron repousserait
   toutes les rumeurs en tête du feed et le tri chronologique perdrait tout son sens.

5. **Résolution des valeurs de marché** — hors ingestion proprement dite, en fin de route cron.
   La file est faite de **joueurs**, pas de lignes : `select distinct tm_player_id` sur les valeurs
   manquantes ou vieilles de plus de sept jours. Un joueur cité dans trois rumeurs ne coûte donc
   qu'une requête, et la valeur arrive d'un coup sur les trois cartes — par Realtime, comme les
   portraits détourés.

   Le lot est petit et espacé (dix fiches, 1,2 s entre chacune) : ce n'est pas un quota qui
   contraint, Transfermarkt n'en impose pas, mais la correction. Une fiche injoignable n'est **pas**
   horodatée — un incident réseau n'est pas un joueur sans valeur, et la condamner à sept jours de
   silence pour une coupure de dix secondes serait disproportionné. Trois échecs d'affilée arrêtent
   le lot : ce n'est plus un joueur en cause mais la source, et continuer brûlerait les soixante
   secondes de la route.

   Placée en dernier volontairement : un incident sur les fiches ne doit jamais priver le feed de
   ses rumeurs, seulement de ses montants.

4 ter. **Dédoublonnage intra-lot** — une page source liste régulièrement deux fois la même rumeur
   (bloc « top », puis bloc « récentes »). Envoyer les deux dans un seul `INSERT` fait échouer
   Postgres : *ON CONFLICT DO UPDATE command cannot affect row a second time*. La dernière
   occurrence gagne, elle porte la probabilité la plus fraîche.
5. **Upsert** :
   ```ts
   supabaseAdmin.from('transfers')
     .upsert(rows, { onConflict: 'external_id', ignoreDuplicates: false });
   ```
   Un `UPDATE` sur une ligne existante déclenche l'événement Realtime : les jauges bougent chez tous
   les clients connectés sans rien de plus. **C'est ce qui fait vivre le feed** — sans les mises à
   jour de probabilité, il ne se passe rien entre deux vrais transferts.

### 5.3 Runner

`app/api/cron/ingest/route.ts`, `runtime = 'nodejs'`, `maxDuration = 60`.

- Rejette (401) toute requête sans `Authorization: Bearer ${CRON_SECRET}`, en comparaison à durée
  constante. **Un `CRON_SECRET` absent ferme l'endpoint au lieu de l'ouvrir** : c'est un point
  d'écriture sur la base, le défaut sûr est le refus.
- `GET` pour Vercel Cron, `POST` pour un déclenchement manuel — même traitement.
- Déclenché par Vercel Cron, `*/30 * * * *`.
- Retourne un `IngestReport` JSON : `{ scanned, inserted, updated, skipped, apiCallsUsed, ms }`.

### 5.4 Seed

`supabase/seed.sql` : 24 lignes réalistes (mix TRANSFER / RUMOUR / EXTENSION, probabilités étalées
5→96, montants variés dont `Libre` et `Prêt`, plusieurs nationalités, deux lignes sans logo pour
exercer le fallback). `external_id` en `manual:*`.

**Le front se développe entièrement sur le seed.** Le scraper (Phase 4) ne doit jamais bloquer le
travail d'interface.

---

## 6. Détourage des portraits

Le rendu « tête détourée » est l'identité visuelle du produit. Il est traité comme une brique à part
entière, asynchrone et faillible, jamais comme un pré-requis à l'affichage d'une carte.

### 6.1 Où tourne le worker

Ni Vercel, ni Render.

- **Vercel** : `@imgly/background-removal-node` embarque ONNX Runtime et un modèle de 40 à 80 Mo.
  Le plan Hobby coupe les fonctions à 60 s, le modèle réclame ~1 Go de mémoire, et chaque cold start
  le recharge. Trop fragile pour une brique qu'on veut oublier.
- **Render** : les *background workers* et les *cron jobs* y sont payants (7 $/mois). On vient de
  retirer Render pour de bonnes raisons, le réintroduire pour ça serait un mauvais échange.

Un corollaire, tiré du sixième : **ce que le code peut trancher exactement, le
code le tranche.** Le champ `qualifier` a passé six passages à sortir `exact`
parce qu'on le demandait au modèle, alors que « environ » et « au moins »
figurent dans la phrase, juste avant le chiffre qu'on vient d'y localiser.

Et un avertissement sur la mesure elle-même : **chaque cadran finit par être
optimisé**. Le taux de rejet ignorait les oublis, jusqu'à ce qu'un passage en
laisse filer un. Le compte de déclarations récompensait le bavardage, jusqu'à
ce qu'un modèle rende cinq fois le même transfert. Un tableau de bord se
corrige aussi souvent que le code qu'il mesure.
- **GitHub Actions** *(retenu)* : gratuit, timeout de 6 h, runner à 16 Go, secrets intégrés, et on y
  installe ce qu'on veut. Le job n'est pas critique en latence — la carte s'affiche déjà avec le
  masque circulaire en attendant. Limites connues et acceptées : les crons GitHub sont *best effort*
  (5 à 20 min de retard possible en heure de pointe) et sont désactivés automatiquement après
  60 jours sans activité sur le dépôt.

Planification : `*/20 * * * *`, 40 portraits maximum par run.

### 6.2 Modèle

`rembg` avec **`isnet-general-use`**, pas le `u2net` par défaut. La différence se joue sur les
cheveux et la ligne d'épaules — exactement là où l'œil regarde sur une carte de 88 px. Alpha matting
activé (`--alpha-matting-foreground-threshold 240`).

### 6.3 Pipeline

1. **File** — `media_cache` où `kind='player'`, `cutout_status='pending'`, `cutout_attempts < 3`.
   Le traitement est **par joueur, pas par rumeur** : un joueur cité trois fois ne passe qu'une fois
   dans le modèle.
2. **Téléchargement** de `image_url`.
3. **Porte de qualité** — si la source fait moins de **200 px** sur le petit côté →
   `cutout_status = 'skipped'`, on n'essaie même pas. Un détourage sur une vignette de 120 px donne
   des contours en dents de scie, franchement pires que le masque circulaire. *C'est cette porte qui
   empêche la feature de dégrader le design au lieu de l'améliorer.*
4. **Détourage** `rembg`.
5. **Post-traitement** Pillow — rognage sur la bounding box alpha → recadrage tête et épaules
   (62 % supérieurs) → padding carré → 320 × 320 → WebP qualité 88.
6. **Upload** vers `cutouts/{name_normalized}.webp`, `upsert: true`,
   `cache-control: public, max-age=31536000, immutable`.
7. **Écriture** `media_cache.cutout_url`, `cutout_status = 'done'`.
8. **Propagation** — `update transfers set player_cutout = … where <joueur>`. Cet `UPDATE` déclenche
   Realtime : **la tête détourée apparaît en direct sur les cartes déjà ouvertes**, sans
   rechargement. La latence du worker devient invisible, elle se transforme même en animation.
9. **Échec** — `cutout_attempts + 1`, statut inchangé ; à 3 tentatives, `failed`.

### 6.4 Chaîne de repli — trois niveaux

| Niveau | Condition | Rendu |
|---|---|---|
| 1 | `player_cutout` présent | Portrait détouré, fond perdu, aligné bas, débord haut |
| 2 | `player_photo` seul | Masque circulaire, `ring-2`, halo d'accent |
| 3 | Aucun visuel | Silhouette sur cercle `slate-800` |

À tout instant le feed contient des lignes dans les trois états. **La carte doit paraître
intentionnelle dans chacun** — c'est le vrai coût de cette décision, et il est en design, pas en
code. À valider en Phase 1, avant d'écrire la moindre ligne du worker.

### 6.5 Le chiffre qui décide de la rentabilité

Tout dépend de la **résolution des portraits sources**. Ceux d'API-Football sont petits ; si la
majorité tombe sous la porte des 200 px, le détourage ne concernera qu'une minorité de cartes et la
journée investie sera mal placée.

Les portraits Transfermarkt (`img.a.transfermarkt.technology/portrait/big/…`) sont plus grands et
posés sur un fond déjà quasi uni — un bien meilleur point de départ pour le modèle.

**Recommandation : tenter Transfermarkt en premier**, retomber sur API-Football. On est déjà sur la
page de la rumeur au moment du scraping, donc l'identifiant du joueur ne coûte rien. À mesurer dès
la première heure de la Phase 4b : le taux de `skipped` dira tout de suite si le pipeline vaut sa
journée, et il vaut mieux le savoir à ce moment-là qu'à la fin.

---

## 7. Variables d'environnement

```bash
# Vercel
NEXT_PUBLIC_SUPABASE_URL=            # public
NEXT_PUBLIC_SUPABASE_ANON_KEY=       # public, lecture seule via RLS
SUPABASE_SERVICE_ROLE_KEY=           # SERVEUR UNIQUEMENT
API_FOOTBALL_KEY=                    # serveur uniquement
CRON_SECRET=                         # serveur uniquement

# GitHub Actions (Settings > Secrets > Actions) — worker de détourage
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=           # le même, dupliqué côté Actions

# Mini PC — worker d'extraction (§13). Aucun secret Supabase ici.
MERCATO_URL=                         # https://mercato-two-zeta.vercel.app
CRON_SECRET=                         # le même jeton porteur que le cron
OLLAMA_URL=                          # défaut http://127.0.0.1:11434
OLLAMA_MODEL=                        # défaut qwen2.5:7b-instruct-q4_K_M
```

**Le mini PC ne détient aucune clé Supabase.** Il parle à `/api/claims`, qui
valide, résout et écrit. Un jeton volé là-bas permet d'envoyer des déclarations
malformées — que le schéma refuse — pas de toucher à la base. C'est cette
frontière qui rend la machine remplaçable.

Le worker a besoin de la `service_role` : il écrit dans Storage et met à jour deux tables. C'est le
seul secret partagé entre Vercel et GitHub Actions — le rotationner impose de le faire aux deux
endroits. Un modèle de fichier prêt à remplir est versionné dans `.env.example`.

`lib/supabase/admin.ts` commence par `import 'server-only'` : une fuite de la service_role dans un
bundle client donne un accès en écriture totale à la base. Le package fait échouer le build au lieu
de laisser passer.

`next.config.ts` :

```ts
images: {
  remotePatterns: [
    { protocol: 'https', hostname: 'media.api-sports.io' },
    { protocol: 'https', hostname: 'tmssl.akamaized.net' },
    { protocol: 'https', hostname: 'img.a.transfermarkt.technology' },
  ],
}
```

---

## 8. Découpage en phases

| Phase | Contenu | Sortie vérifiable | Charge |
|---|---|---|---|
| **0** ✅ | Projet Supabase, migrations, RLS, Realtime, scaffold Next.js | `select` anon OK, `insert` anon refusé | 0,5 j |
| **1** ✅ | Seed 24 lignes, `MercatoCard`, `Crest`, `StatusBadge`, `ProbabilityGauge`, grille | Feed statique complet, responsive 1/2/3 col | 1 j |
| **2** ✅ | `FilterBar`, filtres + URL, Realtime + les 3 correctifs §4.2 | `insert` SQL manuel → carte qui apparaît seule | 0,5 j |
| **3** ✅ | `lib/ingest.ts`, `format.ts`, route cron, fixtures JSON | `POST /api/cron/ingest` rejouable sans doublon | 1 j |
| **4a** | Scraper Transfermarkt + `sources/apifootball.ts` + `media_cache` | Vraies rumeurs avec vraies probabilités | 1 j |
| **4b** | `scripts/cutout.py`, bucket Storage, workflow Actions, propagation Realtime | Portrait détouré qui apparaît en direct sur une carte ouverte | 1 j |
| **5** | *Hors MVP* — microservice Transfermarkt, auth/favoris, notifications push | — | — |

**Total MVP : 5 jours.**

La Phase 4b est la seule qu'on puisse couper sans rien casser : la chaîne de repli du §6.4 fait que
le produit reste complet sans elle, avec le masque circulaire partout. Elle est donc placée en
dernier volontairement — si le taux de `skipped` mesuré au §6.5 est mauvais, on l'arrête là et on
n'aura perdu qu'une demi-journée de mesure.

Chaque phase est mergeable et démontrable seule. À la fin de la Phase 2, le produit est présentable
même si la donnée est fausse — c'est ce qui permet d'arbitrer le design tôt.

---

## 9. Critères d'acceptation du MVP

- [ ] Feed trié par `published_at desc`, 60 lignes, HTML rendu côté serveur (visible en JS désactivé)
- [ ] Les 4 filtres fonctionnent, sont comptés et partageables par URL
- [ ] Un `insert` en base fait apparaître une carte sans rechargement, en moins de 2 s
- [ ] Un `update` de `probability_score` anime la jauge et affiche la tendance
- [ ] Aucun doublon après 3 exécutions consécutives du cron
- [ ] Une ligne sans `player_photo` ni logo s'affiche proprement (fallback initiales)
- [ ] Aucune écriture possible avec la clé `anon` (test explicite)
- [ ] Lighthouse mobile ≥ 90 en performance et accessibilité
- [ ] Consommation API-Football en régime permanent < 20 appels/jour
- [ ] La carte est visuellement aboutie dans les **trois** états de portrait (§6.4)
- [ ] Un `cutout_url` écrit par le worker apparaît en direct sur une carte déjà ouverte
- [ ] Taux de `cutout_status = 'skipped'` mesuré et documenté

---

## 10. Risques

| Risque | Impact | Traitement |
|---|---|---|
| Transfermarkt modifie son HTML | Scraper muet, feed figé | Parse tolérant, `IngestReport.scanned === 0` traité comme une erreur, alerte |
| Conditions d'utilisation Transfermarkt | Le scraping y est interdit | Volume faible, User-Agent honnête, cache 30 min, attribution + lien source sur chaque carte. À revoir si le produit sort du cadre perso. |
| CDN d'images tiers instable | Cartes cassées | `Crest` avec fallback initiales, `onError` systématique |
| Quota API-Football épuisé | Nouvelles cartes sans visuel | Compteur journalier avec coupure à 80, `miss_count` |
| Realtime plafonné (plan gratuit : 200 connexions simultanées) | Feed figé pour les derniers arrivés | Acceptable au MVP. Repli : polling 60 s si l'abonnement échoue. |
| **Portraits sources trop petits** | Détourage inapplicable sur la majorité des cartes | Porte de qualité à 200 px, source Transfermarkt en priorité, mesure dès la première heure de la Phase 4b (§6.5) |
| **Qualité de détourage irrégulière** | Contours sales sur certaines cartes | `isnet-general-use` + alpha matting ; `cutout_status='failed'` retombe sur le masque circulaire, jamais sur une image ratée |
| **Cron GitHub Actions désactivé après 60 j d'inactivité** | File de détourage qui stagne | Alerte si la file dépasse 100 en attente ; le feed reste complet grâce au repli |

---

## 11. État des phases

### Phase 0 — fondations *(livrée)*

Projet Supabase **`mercato`** — `jfqtgphbpogfvofgtnax`, région `eu-west-3`, plan gratuit (0 €/mois).
URL : `https://jfqtgphbpogfvofgtnax.supabase.co`

Migrations appliquées, versionnées dans `supabase/migrations/` :

| Version | Contenu |
|---|---|
| `20260824170814` | `transfer_type`, table `transfers`, trigger `updated_at`, 3 index partiels |
| `20260824171135` | table `media_cache` + index de file du worker |
| `20260824171350` | RLS, policy de lecture publique, `replica identity full`, publication Realtime |
| `20260824171822` | bucket Storage `cutouts` + policy de lecture publique |

Seed appliqué : 24 lignes (`supabase/seed.sql`). Types régénérés dans `lib/types.ts`.

### Vérifications passées

| Test | Résultat |
|---|---|
| `anon` lit `transfers` | 24 lignes ✅ |
| `anon` lit les rumeurs chaudes (`RUMOUR` ≥ 70) | 5 lignes ✅ |
| `anon` lit `media_cache` | 0 ligne — table invisible ✅ |
| `anon` insère dans `transfers` | refusé, table inchangée ✅ |
| Advisors sécurité Supabase | 1 INFO `rls_enabled_no_policy` sur `media_cache` — **comportement voulu** |
| `lib/types.ts` sous `tsc --strict` | aucune erreur ✅ |

### Phase 1 — la carte *(livrée)*

Application Next.js 16 échafaudée à la main (pas de `create-next-app` : le dépôt portait déjà
`docs/`, `lib/` et `supabase/`). Tailwind v4 en configuration CSS-first, fonts Geist via
`next/font`, aucune librairie de composants.

| Livrable | Détail |
|---|---|
| `MercatoCard` | En-tête club → club, portrait, badge, montant, jauge, pied traçable |
| `PlayerPortrait` | Chaîne de repli à 3 niveaux, dégradation automatique sur image cassée |
| `Crest` | Écusson avec repli initiales, sensible aux acronymes (`PSV Eindhoven` → `PSV`) |
| `StatusBadge` | Pastille, couleur dérivée de `accentOf()`, libellé tronqué avec `title` |
| `ProbabilityGauge` | Barre néon + tendance, `role="progressbar"`, transition prête pour Realtime |
| `app/page.tsx` | Server Component, tri `published_at desc`, grille 1/2/3 colonnes |
| `app/preview` | Banc de rendu (§4.8) |

Vérifié au navigateur (Chromium, captures en 1440 et 390 px) : aucun débordement horizontal,
les pieds de carte s'alignent en grille étirée, les trois niveaux de portrait et les quatre
accents rendent comme prévu.

Trois défauts trouvés et corrigés à cette occasion, tous invisibles à la lecture du code :
le portrait détouré paraissait plus petit que le masque circulaire alors qu'il doit dominer ;
les libellés de statut longs passaient sur deux lignes et cassaient la pastille ; `clubInitials`
réduisait `PSV Eindhoven` à `PE` en ignorant l'acronyme déjà présent.

**Décision d'implémentation** : Next.js **16** et non 15. C'est la version stable au moment du
scaffold, sur un projet neuf sans dette à porter.

### Phase 2 — vivant *(livrée)*

| Livrable | Détail |
|---|---|
| `lib/filters.ts` | Les 4 filtres et le seuil « chaud », partagés serveur/client |
| `lib/feed.ts` | `mergeRows()` et `maxCreatedAt()` — logique pure, testable sans réseau |
| `FilterBar` | Onglets comptés, soulignement de l'actif, indicateur de connexion |
| `MercatoFeed` | État, abonnement Realtime, rattrapage, repli polling, synchronisation d'URL |
| `app/preview/feed` | Banc d'interaction sur fixtures |

**Le filtre initial est lu côté serveur**, pas via `useSearchParams` : le premier rendu part déjà
sur le bon onglet, la page n'a pas besoin d'une frontière Suspense, et `?f=` étant une entrée
utilisateur, toute valeur inconnue retombe sur « Tous ».

**Vérifications.** 13 tests `node:test` sur la fusion et les filtres — dédoublonnage d'un événement
rejoué, remplacement en place sur `UPDATE`, tri sur `published_at` et non sur l'ordre d'arrivée,
troncature à 200 en gardant les plus récentes, suppression, non-mutation de l'entrée, repère de
rattrapage, bornes du seuil à 70 (69 exclu, 70 inclus), rejet des clés de filtre inconnues.
Puis 10 vérifications au navigateur : compteurs, filtrage réel, écriture et nettoyage de `?f=`,
lien profond actif dès le rendu serveur, état vide propre à chaque filtre, aucun débordement
horizontal en 1440 / 768 / 390 px.

**Écart assumé sur les specs.** Le §4.2 prévoyait une flèche de tendance visible 5 s après un
`UPDATE`. La tendance étant stockée en base (`previous_probability`), la masquer ferait perdre une
information durable. Retenu à la place : la tendance reste affichée en permanence, et c'est la
**carte** qui pulse 1,5 s pour signaler qu'elle vient de changer. Sur une grille de 60 cartes,
c'est ce repérage-là qui manquait.

**Ce que l'egress bloqué a permis de vérifier.** Realtime étant injoignable depuis la session,
l'indicateur bascule sur *Différé 60 s* et le repli du §10 s'exécute réellement. Le chemin nominal
(`SUBSCRIBED`, rattrapage, événements) reste à valider sur une base joignable.

### Phase 3 — pipeline *(livrée)*

| Livrable | Détail |
|---|---|
| `lib/ingest.ts` | Validation Zod, dédoublonnage de lot, normalisation, upsert par lots de 50 |
| `lib/format.ts` | `parseFee()` / `formatFee()` / `normalizeName()` |
| `lib/supabase/store.ts` | Implémentation Supabase des dépôts `TransferStore` et `MediaStore` |
| `lib/sources/fixtures.ts` | Source de démonstration, à la signature du futur scraper |
| `app/api/cron/ingest` | Route protégée, `GET` (Vercel Cron) et `POST` (manuel) |
| `vercel.json` | Cron `*/30 * * * *` |

**Décision d'architecture : `ingest()` ne connaît que des interfaces**, pas Supabase. `TransferStore`
et `MediaStore` sont injectés. Ce n'est pas de l'abstraction gratuite — c'est ce qui rend le critère
d'acceptation « aucun doublon après 3 exécutions » vérifiable sans base ni réseau, contre un dépôt
en mémoire qui reproduit les contraintes réelles de Postgres.

**Deux règles absentes des specs initiales**, trouvées en écrivant le pipeline, chacune corrigeant
un bug qui n'aurait pas fait échouer le critère des 3 exécutions :

1. `previous_probability` n'est déplacé que si la probabilité a changé — sinon la tendance
   s'efface à la première moisson sans changement.
2. `published_at` n'est repris de la source que si elle en fournit un — sinon chaque cron repousse
   tout le feed en tête.

**Vérifications.** 42 tests `node:test` au total (14 sur l'ingestion, 15 sur le formatage, 13 de la
Phase 2). Le dépôt en mémoire lève l'erreur réelle de Postgres
*« cannot affect row a second time »* quand une clé apparaît deux fois dans un lot, ce qui rend le
dédoublonnage réellement testé.

Côté base, en SQL direct : trois upserts identiques laissent 3 lignes et 3 `external_id` distincts ;
un lot portant deux fois la même clé est bien refusé par Postgres (`cardinality_violation`), ce qui
confirme la fidélité du double de test. Lignes de vérification supprimées, les 24 du seed intactes.

Côté route, la porte d'authentification a été éprouvée : sans en-tête, jeton faux, bon préfixe
tronqué et mauvais schéma renvoient tous 401 ; le bon jeton passe.

**Non vérifié.** Le trajet complet route → Supabase reste bloqué par l'egress de la session : avec
le bon jeton, la réponse est un 500 portant `Host not in allowlist`. Le pipeline s'exécute donc
jusqu'à la première requête réseau, pas au-delà.

### Ce qui reste à faire à la main

La `service_role` n'est **pas** récupérable par outillage et n'a rien à faire dans le dépôt :
à copier depuis *Supabase → Project Settings → API* vers les variables Vercel **et** les secrets
GitHub Actions. Idem pour `API_FOOTBALL_KEY` et un `CRON_SECRET` aléatoire.

### Note d'environnement — sessions Claude Code sur le web

Le serveur Next.js lancé **dans une session Claude Code web** ne joint pas
`jfqtgphbpogfvofgtnax.supabase.co` : le proxy d'egress répond `Host not in allowlist`. Le feed
affiche alors son état d'erreur, ce qui est le comportement voulu — mais ce n'est pas un bug de
l'application. En local et sur Vercel, l'accès est direct et fonctionne.

Pour lever la restriction en session web, ajouter l'hôte aux réglages d'egress de l'environnement.
Sans cela, `/preview` reste le moyen de travailler le design, puisqu'il ne dépend pas de la base.

---

## 12. Point de reprise

### Ce qui tourne déjà, vérifié en conditions réelles

| Brique | État |
|---|---|
| Base Supabase `jfqtgphbpogfvofgtnax` | Schéma, RLS, Realtime, Storage, seed — en ligne |
| Scraper Transfermarkt | 15 rumeurs/passage, ~10 probabilités, portraits **et** écussons |
| Ingestion idempotente | 3 exécutions → 0 doublon, vérifié sur données réelles |
| Worker de détourage | Tourne sur GitHub Actions, run manuel en succès |
| Tests | 105 `node:test`, `npm test` |
| Déploiement Vercel | En production, variables posées, ingestion rejouée en ligne sans doublon |

**API-Football n'est plus nécessaire.** Le compte est bloqué définitivement, mais
Transfermarkt fournit portraits et écussons sans clé ni quota. La route dégrade
proprement quand `API_FOOTBALL_KEY` est absente — ne pas la remettre.

### Le déploiement Vercel

| | |
|---|---|
| Projet | `mercato` — `prj_2myZ0SpERcnHdGAARcQcaEwWdUJw`, équipe `sachagigois-projects`, plan Hobby |
| Dépôt lié | `sachagigoi/mercato`, branche de production `claude/mercato-webapp-mvp-agsll7` |
| Production | <https://mercato-two-zeta.vercel.app> |
| Variables | Les quatre posées, sur les trois environnements |
| Protection | Vercel Authentication désactivée — la route cron doit rester joignable depuis GitHub Actions |
| Région des fonctions | `cdg1` (Paris), fixée dans `vercel.json` — la base est en `eu-west-3` |

Tout `push` sur la branche de production redéploie en production ; un `push` sur
une autre branche produit un déploiement de prévisualisation. Les outils MCP
Vercel, eux, ne savent créer que des previews : reconstruire la production
demande un commit sur la branche de production, ou une promotion manuelle
depuis le dashboard.

Les deux `NEXT_PUBLIC_` sont **figées dans le bundle au moment du build**. Les
poser ne suffit pas : sans redéploiement, le navigateur continue de recevoir un
bundle compilé sans clé, et le Realtime avec. C'est toute la différence entre le
premier déploiement — bâti à vide, feed en erreur — et celui qui sert
aujourd'hui.

### Ce qui a été vérifié en production

| Vérification | Résultat |
|---|---|
| Feed | 200, cartes rendues côté serveur, aucun bandeau d'erreur |
| Bundle client | URL Supabase et clé publishable bien inlinées ; **aucune trace de `service_role`** dans les huit chunks — le garde-fou `server-only` tient |
| Route cron | 401 sans jeton, 200 avec — `CRON_SECRET` est bien en place |
| Ingestion, 1er passage | 15 scannées, 12 insérées, 3 mises à jour, 0 écartée, 0 erreur |
| Ingestion, 2e passage | 15 scannées, **0 insérée**, 15 mises à jour — idempotence tenue en ligne |
| Valeurs de marché | 10 fiches demandées, 10 résolues, 0 échec au premier passage |
| Pays et championnat | 15 rumeurs situées sur 15 |
| Doublons | 87 lignes, 87 `external_id` distincts |
| API-Football | `media: { skipped: "API_FOOTBALL_KEY absente" }` — la dégradation prévue, sans échec |

La moisson tourne donc depuis Vercel : `transfermarkt.com` est joignable depuis
les fonctions, sans le `NODE_USE_ENV_PROXY` nécessaire en session web.

### Ce qu'il reste à faire

**1. Deux secrets GitHub**, pour le workflow d'ingestion :
`MERCATO_URL` = `https://mercato-two-zeta.vercel.app` et `CRON_SECRET`
(identique à celui de Vercel). Sans eux le workflow sort en code 2 avant tout
appel. Les secrets du worker de détourage (`SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`) sont déjà en place et éprouvés.

**2. Rattraper les valeurs de marché.** La résolution traite dix joueurs par
passage, et le rattrapage de `tm_player_id` en a mis soixante-cinq en file : le
feed se remplit donc au rythme du cron, quelques heures. Rien à faire, sinon
constater — mais tant que les secrets GitHub du point 1 manquent, le cron ne
tourne pas, et la file n'avance pas.

Le pays, lui, ne se rattrape pas : il n'est pas dans la clé naturelle, et il
faudrait retrouver chaque ancienne rumeur dans une page qui ne les liste plus.
Les lignes moissonnées avant cette version resteront donc hors des puces de
pays jusqu'à leur sortie du feed.

**3. Vérifier le Realtime — moitié faite.** Le point restait entier faute de
navigateur. Il se coupe en deux, et **la moitié serveur est désormais vérifiée
en base** :

| Fait | Constat |
|---|---|
| `public.transfers` dans la publication `supabase_realtime` | oui — `insert`, `update` et `delete` |
| `replica identity` de `transfers` | `full` : l'ancien enregistrement voyage avec le nouveau |
| Contrôle d'accès du canal | `transfers_public_read` accordée à `anon` — Realtime applique la RLS du rôle qui s'abonne, l'abonné anonyme passe |
| `declarations`, `press_articles`, `media_cache` | RLS active, **aucune policy**, et **hors publication** : pas de fuite par le canal non plus |

Ce dernier point vaut d'être noté : rendre une table invisible côté client ne
dit rien de sa diffusion en temps réel. Les deux portes sont fermées, mais ce
sont bien **deux** portes.

Reste la jambe cliente, et elle seule : **la WebSocket depuis un vrai
navigateur.** Elle ne s'établit pas depuis une session Claude Code web — non
que l'hôte soit injoignable, comme on l'a d'abord cru : une requête HTTP
atteint bien `…supabase.co/realtime/v1/websocket`, qui répond
`401 MISSING_API_KEY`. C'est le relais TLS de l'environnement qui coupe la
poignée de main de Chromium, connexion réinitialisée après 39 octets. Le repli
polling 60 s masque alors le problème, et le HTML servi ne tranche pas
davantage — l'indicateur part de « Connexion » et ne bascule qu'une fois le
canal souscrit.

Ouvrir le feed dans un navigateur ordinaire, confirmer que l'indicateur de la
barre de filtres affiche **« En direct »** et non « Différé 60 s », puis faire
un `update` de `probability_score` en SQL et vérifier que la jauge bouge sans
rechargement.

**4. Rapprocher les fonctions de la base — fait.** Le projet avait été créé en
`iad1` (Washington) alors que la base est en `eu-west-3` (Paris) : chaque rendu
serveur du feed traversait l'Atlantique deux fois. La région est désormais
`cdg1`, **posée dans `vercel.json`** plutôt que dans le dashboard — la
configuration prime sur le réglage de projet, et vit dans le dépôt : elle se
relit, se révise en revue, et survit à une recréation du projet. Le plan Hobby
autorise une région, et le gain porte directement sur le TTFB, donc sur le
critère Lighthouse du §9.

Vérifié sur le déploiement de prévisualisation, en comparant l'en-tête
`x-vercel-id` de la preview et de la production sur la même requête :
`iad1::cdg1::…` contre `iad1::iad1::…`. Le premier segment est le PoP
d'entrée, le second la région d'exécution — c'est celui-là qui a bougé. **La
production restera en `iad1` jusqu'à la fusion** : c'est la branche de
production qui porte le réglage.

### Pièges d'environnement rencontrés

- **`NODE_USE_ENV_PROXY=1`** est nécessaire en session Claude Code web : le
  `fetch` de Node ignore `HTTPS_PROXY` et sort par une route dont l'egress est
  plus strict. Inutile en local et sur Vercel.
- **`www.transfermarkt.fr` n'est pas dans l'allowlist** de l'environnement,
  `.com` oui — d'où la locale retenue. Sans conséquence produit, les libellés de
  statut étant dérivés de la probabilité.
- **Cron Vercel** : plafonné à un par jour sur le plan Hobby, et le déploiement
  est *refusé* au-delà. D'où l'ingestion déplacée sur GitHub Actions (§8).
- **Variables d'environnement Vercel** : ni les outils MCP ni la CLI ne sont
  disponibles pour les poser. Une session qui reprend le sujet doit passer par
  le dashboard, ou disposer d'un token Vercel.

---

## 13. Pipeline multi-sources — de l'article à la piste

Le feed sait dire *qu'un* transfert se murmure. Il ne sait pas dire **combien**,
parce que Transfermarkt ne publie pas de montant sur une rumeur. Or c'est
exactement l'écart qui intéresse : la valeur marchande du joueur **face à** la
valeur du transfert évoquée par la presse.

Ce montant existe, mais en prose : « l'OL réclame 40 M€ pour céder son ailier ».
Il n'y a pas de source structurée à brancher — il faut le **capturer**, article
par article, et l'attacher à la bonne piste.

### 13.1 Le sens du pipeline : de l'article vers la piste

Deux directions étaient possibles. Partir des rumeurs Transfermarkt et chercher
les articles qui en parlent ; ou partir des articles et décider ensuite quelle
piste ils concernent.

**C'est la seconde.** Une rumeur est vivante : d'autres clubs se positionnent,
un chiffre sort, un démenti tombe. Une piste peut naître dans la presse avant
d'exister chez Transfermarkt. Partir de la rumeur imposerait de la relire à
chaque passage pour savoir si elle a bougé ; partir de l'article donne un flux
d'observations horodatées, dont chacune enrichit ou crée.

```
flux RSS ─┐
          ├─ préfiltre titre + chapô ──→ hors L1 : jamais téléchargé
     article téléchargé
          ├─ préfiltre sur le corps ───→ hors L1 / vide : jamais soumis
   phrases numérotées ──→ Ollama (schéma contraint) ──→ déclarations brutes
          └────────────── garde-fou ────────────────────┘
                             │
              ┌──────────────┼──────────────┐
           retenue         rejetée     hors périmètre
                │
        POST /api/claims ──→ press_articles + declarations
```

### 13.2 Périmètre : Ligue 1, entrant et sortant

Une déclaration n'est retenue que si **au moins un des deux clubs** est en Ligue
1. Ce n'est pas qu'un cadrage produit : c'est ce qui rend l'inférence sur CPU
tenable. Mesuré sur un flux réel, 10 articles sur 25 passent la porte — le reste
n'est jamais présenté au modèle et ne coûte rien.

Le périmètre est tenu par `lib/referential.ts` : les 18 clubs, leurs alias de
presse, et **les identifiants Transfermarkt comme clés**. C'est la pièce qui
rend le rapprochement possible sans ressembler à de la magie — *le modèle lit
des noms, le code résout des clés*. Les noms sont flous et c'est le travail d'un
modèle ; les clés sont exactes et c'est le travail d'une table.

### 13.3 Où tourne quoi, et pourquoi

| | Où | Pourquoi là |
|---|---|---|
| Scraping + Ollama | **Mini PC** (i5, 16 Go) | Un modèle de 5 Go ne se charge pas dans une fonction serverless. |
| Validation, résolution, écriture | **Vercel** (`/api/claims`) | Le worker ne détient aucune clé Supabase. Un jeton volé n'ouvre rien. |
| Toute la logique | **Le dépôt**, sous `npm test` | n8n n'orchestre que l'appel. Le jour où il gêne, un `cron` le remplace sans rien réécrire. |

Le worker envoie ses **observations** — le nom lu, la citation copiée, le
montant converti par un parseur testé. Jamais ses conclusions : les clés de
clubs sont recalculées côté serveur, à partir des libellés bruts. Une correction
du référentiel s'applique alors au prochain envoi, sans toucher au mini PC.

### 13.4 Le garde-fou — ce qui rend un 7B local acceptable

**Le modèle ne produit jamais un fait directement affichable.** Il rend
l'*indice* d'une phrase ; le code en tire la citation. Elle est donc exacte par
construction — aucune vérification de sous-chaîne ne peut échouer sur une
apostrophe — et ça coûte deux tokens au lieu de quarante, sur un CPU à
3 tokens/s.

Trois contrôles, et un seul est verrouillé au niveau de la phrase :

- **Le montant est cherché dans l'article, et comparé en valeur** — pas en
  caractères, et pas à l'endroit que le modèle désigne. C'est le contrôle qui
  attrape l'hallucination coûteuse : un chiffre plausible, bien formé, et absent
  de l'article. Les deux versions plus strictes qui l'ont précédé n'ont rejeté
  que des extractions justes (§13.5).
- **Le nom du joueur est vérifié sur l'article entier.** L'exiger dans la
  citation rejetait des extractions justes — la presse alterne nom et périphrase
  (« pour *l'international français* »). Sa présence dans la citation devient un
  `player_in_quote` de confiance, pas une condition.
- **Le périmètre est vérifié deux fois**, côté worker et côté serveur. Le
  serveur ne peut pas présumer de qui lui écrit.
- **Tout ce que le modèle affirme doit se retrouver dans le texte.** La règle
  s'est étendue champ par champ, chaque fois sur un cas réel : le club de L1
  attribué doit être cité, la nature de l'opération (`libre`, `pret`, `clause`)
  doit être dite. Un champ non attesté est déclassé plutôt que rejeté quand le
  reste de la déclaration tient — corriger le champ vaut mieux que perdre le
  fait.

Un rejet n'est pas un incident : c'est **la mesure**. Le taux de rejet se lit
sans étiqueter quoi que ce soit et sert de cadran de précision — il monte le
jour même où un changement de modèle ou de consigne fait dériver l'extraction.

Il ne dit rien du **rappel**, et c'est sa limite : il ne voit que ce que le
modèle a produit, jamais ce qu'il a laissé passer. Un passage réel a manqué une
signature libre sans qu'aucun chiffre ne bouge. D'où le second cadran, la part
d'articles dont le modèle ne tire *ni déclaration ni rejet* : un article de L1
peut légitimement ne parler d'aucun mouvement, mais une part qui monte est un
oubli qui s'installe.

### 13.5 Ce que huit passages réels ont corrigé

Aucun de ces défauts n'était visible sur le papier.

| Passage | Symptôme | Cause, et correctif |
|---|---|---|
| 1 | **100 % de rejet** | On demandait un montant *en euros* — donc une multiplication par un million, ce qu'un 7B rate volontiers, alors qu'un parseur testé attendait à côté. Et le schéma n'offrait aucune façon légale de dire « aucun montant » : un décodeur contraint en fabrique alors un. Le modèle recopie désormais, `null` est un type valide, et la consigne dit que l'absence de montant est le cas normal. |
| 2 | **Aucun club, posture aléatoire** | `fromClub`, `toClub` et `stance` figuraient au schéma mais nulle part dans la consigne. Un décodeur contraint omet ce qu'on ne lui demande pas et tire au hasard dans une énumération qu'on ne lui explique pas. |
| 3 | **Une extraction juste rejetée** | « Les représentants disposent d'un accord avec l'AS Roma » et « l'OL réclame 40 M€ » sont deux phrases ; le schéma n'autorisait qu'un seul indice. `feeSentence` laisse le montant citer sa propre phrase. |
| 4 | **Les deux seules extractions chiffrées rejetées**, et un oubli invisible | Le modèle normalise la notation vers celle du titre : « 40 millions d'euros » pour « 40 M€ », « 9,3 M€ » pour « 9,3 millions d'euros ». L'indice de phrase était juste dans les deux cas — c'est la comparaison littérale qui rejetait. On compare désormais des **valeurs**, et on cherche le montant dans tout l'article. Le même passage a laissé filer une signature libre sans qu'aucun chiffre ne s'en aperçoive : d'où le cadran des silences, et une consigne qui dit qu'un transfert sans montant compte autant qu'un autre. |

| 5 | **Zéro rejet, et deux déclarations sur six attendues** | Précision parfaite, rappel médiocre — la panne inverse des précédentes. Sur « PSG : Liverpool avance pour Barcola », `fromClub` à null alors que le PSG est dans le titre : la déclaration sort du périmètre sans un mot. Le préfiltre connaissait déjà le club et ne s'en servait pas. La consigne annonce désormais les clubs de L1 cités, et un garde-fou symétrique refuse un club attribué que l'article ne cite pas. |

| 6 | **Le rappel remonte, `fromClub` résiste** | Sur les mêmes cinq brèves : trois déclarations au lieu de deux, plus aucun silence. Mais `fromClub` reste à null dans les trois cas où le club d'origine est étranger. « Le club qu'il quitte » demande de trancher un sens ; la consigne demande désormais « le club où il joue aujourd'hui ». Le champ `qualifier`, lui, sortait toujours à `exact` — la nuance (« environ », « au moins ») se lit maintenant dans le texte juste avant le chiffre, ce que le code fait mieux et gratuitement. |
| 7 | **Le 3B mesuré : plus rapide, et inutilisable ici** | 31 s contre 42 s par article, mais aucun des deux montants que le 7B trouvait, cinq entrées pour un seul transfert, et quatre sorties hors schéma sur un même article. Le montant est le produit. Le passage a surtout révélé deux défauts du tableau de bord : les doublons comptaient comme des déclarations (repliés avant comptage désormais, en gardant la chiffrée), et un rejet de schéma ne nommait pas le champ fautif. |
| 8 | **Le premier passage propre**, et un mot de trop | Cinq brèves, cinq déclarations, aucun rejet, aucun silence, aucun doublon. `fromClub` se remplit sur les départs vers l'étranger, les nuances apparaissent. Reste `feeKind: libre` sur un joueur sous contrat, dans un texte qui n'emploie jamais le mot : cette nature allume une pastille « Libre » sur la carte, donc elle doit être attestée par le texte, sinon elle est déclassée en « inconnu ». |

**Ce que la série enseigne** : les trois premiers défauts venaient du schéma,
les deux suivants de ce que la consigne *ne dit pas*. Un décodeur contraint ne
se tient pas mal — il fait exactement ce qu'on lui a demandé, y compris quand on
ne lui a rien demandé. Et chaque tour de vis sur le rappel appelle son garde-fou
sur la précision : pousser le modèle à remplir les clubs sans vérifier qu'ils
sont dans le texte échangerait un oubli contre une erreur d'attribution, ce qui
serait un mauvais échange.

### 13.7 Le rapprochement — de la déclaration à la carte

C'est la pièce qui relie le pipeline au produit. Sans elle l'extraction peut
être parfaite : `transfer_id` reste nul, et rien n'atteint le feed.

Elle répond à une seule question, article par article : **parle-t-on d'une
piste déjà connue, ou d'une nouvelle ?**

```
déclaration en attente
   │
   ├─ même joueur, même destination ────────→ c'est la même piste
   ├─ même joueur, même origine, et une
   │  destination inconnue d'un côté ───────→ la même piste, qui se précise
   └─ sinon ─────────────────────────────────→ une autre piste
                                                 │
                          destination nommée ? ──┴── non → reste en file
                                     │
                                    oui → ingest() ouvre la piste
```

**Les deux erreurs ne se valent pas**, et tout le module penche d'un côté. Un
doublon dans le feed se voit et se corrige ; un montant posé sur la mauvaise
piste se lit comme un fait. Les clubs étrangers n'ayant pas de référentiel, ils
se comparent par libellé normalisé — « Man City » et « Manchester City » ne se
rejoindront pas, et c'est un doublon assumé plutôt qu'une fusion hasardeuse.

| Décision | Pourquoi |
|---|---|
| **Le montant n'est posé que si la piste n'en a pas** | Une rumeur Transfermarkt arrive sans montant : c'est exactement le trou que la presse comble. Un transfert conclu, lui, porte le chiffre officiel, qu'une estimation de presse n'a pas à écraser. La condition vit dans la requête (`is('fee_value_eur', null)`), pas seulement dans la lecture : entre les deux, l'ingestion a pu passer. |
| **Le lien est posé même quand rien ne change** | L'observation vaut d'être conservée : c'est elle qui permettra d'afficher « trois sources concordent ». |
| **Créer passe par `ingest()`** | `lib/ingest.ts` reste le point d'entrée UNIQUE de `transfers`. La piste née de la presse subit donc la même validation, le même dédoublonnage, et entre dans la file des visuels comme les autres. |
| **Pas de piste sans destination** | Une carte « Fofana → ? » n'apprend rien. La déclaration attend la rumeur Transfermarkt plutôt que d'ouvrir une piste borgne. |
| **Pas de piste depuis un démenti** | Ce serait faire naître une rumeur d'un article qui affirme qu'elle est fausse. Un démenti enrichit une piste ; il n'en ouvre pas. |
| **Clé naturelle sans la source** | `press:{joueur}:{destination}` — deux journaux qui rapportent le même mouvement produisent une piste, pas deux cartes. |

Le score d'une piste née de la presse **encode la posture déclarée**, il ne la
calcule pas : rumeur 40, discussions 55, accord 75, officiel 100. Ce n'est pas
une probabilité, et le Rumourometer de Transfermarkt n'est jamais écrasé par
cet encodage sur les pistes qui en ont un.

**Deux points d'appel, pour deux latences.** Le rapprochement suit l'écriture
dans `/api/claims` — une déclaration dont la piste existe déjà atteint la carte
tout de suite — et il suit la moisson dans le cron : les rumeurs qui viennent
d'entrer sont précisément celles que des déclarations attendaient. Une brève de
presse paraît souvent avant que Transfermarkt ne publie la rumeur.

La jointure s'appuie sur `transfers.player_normalized`, colonne **générée**
depuis `player_name`. Un `ilike` sur le nom brut ignore la casse mais pas les
accents, et raterait « Paixão » contre « Paixao » — exactement les noms que ce
produit manipule. L'accord entre `public.normalize_name` (SQL) et
`normalizeName` (TypeScript) a été vérifié sur les accents, apostrophes,
traits d'union et espaces doublés avant d'y adosser la jointure.

### 13.6 État

Livré et testé : le contrat de source (`lib/articles.ts`), la source Maxifoot,
le référentiel, le préfiltre, le garde-fou, le worker Ollama, les deux tables et
l'endpoint `/api/claims`. Le mode d'emploi du mini PC est dans
`docs/EXTRACTION.md`.

**L'envoi est opt-in.** Sans `--send`, le worker n'écrit rien vers la base —
c'est volontaire : rien n'atterrit en base avant qu'on ait un taux de rejet
regardable, mesuré sur de vrais articles.

Le **rapprochement** (§13.7) est branché : les déclarations trouvent leur
piste, ou en ouvrent une, et le montant de presse atteint la carte.

Reste à faire : le banc d'essai sur articles étiquetés, puis les sources
suivantes — chacune n'apportant qu'un parseur, le contrat étant déjà là. Et
deux affinages que la première mesure en conditions réelles tranchera : les
libellés de clubs étrangers, qui produisent aujourd'hui des doublons assumés,
et la place de la posture déclarée dans le score affiché.
