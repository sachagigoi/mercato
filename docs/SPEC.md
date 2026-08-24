# Mercato — Spécifications techniques MVP

> Feed temps réel de transferts et rumeurs football. Next.js 16 (App Router) · Supabase · Tailwind v4.
> Document de référence unique pour le MVP.

**État : Phases 0 et 1 livrées.** Base Supabase en ligne et vérifiée, application Next.js
échafaudée, `MercatoCard` et la grille responsive en place, banc de rendu à `/preview` — cf. §11.

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

  -- Deal
  transfer_fee        text,              -- libellé d'affichage : '45 M€', 'Prêt', 'Libre'
  fee_value_eur       bigint,            -- valeur numérique ou null ; tri et filtres
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
| `player_cutout` | Séparée de `player_photo` plutôt que de l'écraser. Le détourage est asynchrone et faillible : garder la source intacte permet de retomber dessus, et de rejouer le worker après un changement de modèle sans avoir rien perdu. |

### 2.3 Index

```sql
create index transfers_feed_idx     on public.transfers (published_at desc) where is_published;
create index transfers_type_idx     on public.transfers (type, published_at desc) where is_published;
create index transfers_hot_idx      on public.transfers (probability_score desc)
  where is_published and type = 'RUMOUR';
```

Les trois index couvrent exactement les quatre filtres de la barre. Index partiels : `is_published`
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

---

## 3. Arborescence

```
app/
  layout.tsx                    # thème sombre, fonts, metadata, OG
  page.tsx                      # RSC : fetch initial 60 lignes
  globals.css                   # @theme Tailwind v4 + tokens
  api/cron/ingest/route.ts      # runner d'ingestion (protégé par CRON_SECRET)
  preview/page.tsx              # banc de rendu des composants (§4.8)
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
  ingest.ts                     # normalisation + upsert (cœur du brief §3.3)
  sources/transfermarkt.ts      # scraper rumeurs
  sources/apifootball.ts        # résolution visuels + cache + budget
  format.ts                     # parsing montants, emoji drapeau, temps relatif
  accent.ts                     # accentOf() + map de classes littérales
  fixtures.ts                   # jeu de cas limites du banc de rendu
  types.ts                      # types générés depuis Supabase
public/demo/                    # gabarits de portrait (Phase 1)
scripts/
  cutout.py                     # worker de détourage (hors bundle Next.js)
  requirements.txt              # rembg, pillow, httpx, supabase
.github/workflows/
  cutout.yml                    # cron GitHub Actions, */20
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

### 4.4 Drapeau depuis le code ISO

```ts
export const flagEmoji = (iso?: string | null) =>
  iso?.length === 2
    ? String.fromCodePoint(...[...iso.toUpperCase()].map(c => 0x1f1e6 + c.charCodeAt(0) - 65))
    : '';
```

### 4.5 `MercatoCard` — anatomie

```
┌──────────────────────────────────────────────────┐
│  [logo]  OM   ──────➔──────   PSG  [logo]        │  header, h-16, séparateur bas
├──────────────────────────────────────────────────┤
│   ╭────╮   RAYAN CHERKI  🇫🇷                      │  body
│   │tête│   ● Piste chaude                        │  badge = accentOf()
│   ╰────╯   45 M€                                 │  text-2xl font-bold tabular-nums
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

Chaque onglet affiche son compteur. Le filtre actif est reflété dans l'URL (`?f=hot`) via
`useSearchParams` + `history.replaceState` : un feed filtré doit être partageable.

État vide par filtre (« Aucune rumeur chaude pour l'instant ») — jamais une grille blanche.

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
  playerName: string;
  nationalityCode?: string;
  fromClub?: string;
  toClub?: string;
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

- Rejette (401) toute requête sans `Authorization: Bearer ${CRON_SECRET}`. **Un endpoint d'écriture
  ouvert est une porte d'entrée pour polluer la base.**
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
```

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
| **0** | Projet Supabase, migrations, RLS, Realtime, scaffold Next.js | `select` anon OK, `insert` anon refusé | 0,5 j |
| **1** | Seed 24 lignes, `MercatoCard`, `Crest`, `StatusBadge`, `ProbabilityGauge`, grille | Feed statique complet, responsive 1/2/3 col | 1 j |
| **2** | `FilterBar`, filtres + URL, Realtime + les 3 correctifs §4.2 | `insert` SQL manuel → carte qui apparaît seule | 0,5 j |
| **3** | `lib/ingest.ts`, `format.ts`, route cron, fixtures JSON | `POST /api/cron/ingest` rejouable sans doublon | 1 j |
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
