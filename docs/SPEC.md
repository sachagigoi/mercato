# Mercato — Spécifications techniques MVP

> Feed temps réel de transferts et rumeurs football. Next.js 15 (App Router) · Supabase · Tailwind v4.
> Statut : specs validées pour implémentation. Document de référence unique pour le MVP.

---

## 0. Décisions d'architecture (et pourquoi)

Quatre écarts par rapport au brief initial, tous motivés par une contrainte vérifiée.

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

**Décision MVP** : masque circulaire + `ring` + halo radial dans la couleur d'accent du type. On
obtient le rendu carte FIFA sans pipeline de détourage. Un vrai détourage (`@imgly/background-removal`
à l'ingestion, stockage Supabase Storage) est chiffré en Phase 5 — c'est un sujet à part entière,
pas une ligne de CSS.

### 0.4 Le schéma initial n'est pas ré-exécutable

`transfers` tel que spécifié n'a aucune clé naturelle. Deuxième passage du script d'ingestion =
doublons dans le feed. C'est le bug numéro un de tout pipeline de scraping.

**Décision** : ajout de `external_id text unique` + `upsert on conflict`. Détaillé en §2.

---

## 1. Stack

| Couche | Choix | Note |
|---|---|---|
| Framework | Next.js 15, App Router, TypeScript strict | RSC pour le fetch initial |
| Styling | Tailwind CSS v4 (config CSS-first `@theme`) | dark-only, pas de toggle |
| DB / Realtime | Supabase (Postgres 17, région `eu-west-3`) | projet dédié, plan gratuit (0 €/mois) |
| Rumeurs | Scraper Cheerio → `transfermarkt.us/statistik/aktuellegeruechte` | Route Handler, pas de service externe |
| Visuels | API-Football (api-sports.io) | cache obligatoire, cf. §0.2 |
| Hébergement | Vercel | Cron Jobs pour l'ingestion |
| Fonts | Geist Sans + Geist Mono (`next/font`) | `tabular-nums` pour les montants |

**Aucune librairie de composants** (pas de shadcn, pas de Radix). Six composants au total, tous
maîtrisés. Une seule dépendance runtime hors stack : `cheerio`.

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
  player_photo        text,
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
  image_url        text,
  miss_count       smallint not null default 0,
  fetched_at       timestamptz not null default now(),
  unique (kind, name_normalized)
);
```

C'est cette table qui rend le quota de 100 req/jour vivable. `miss_count` évite de re-brûler du
quota sur un club introuvable à chaque run : au-delà de 3 échecs, on n'interroge plus et le front
tombe sur le fallback initiales (§4.5).

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
components/
  MercatoFeed.tsx               # 'use client' — état, realtime, filtres
  FilterBar.tsx                 # 'use client' — 4 onglets
  MercatoCard.tsx               # présentationnel pur, zéro état
  ProbabilityGauge.tsx          # jauge néon + tendance
  StatusBadge.tsx               # pastille colorée
  Crest.tsx                     # logo club, fallback initiales
lib/
  supabase/client.ts            # navigateur (anon)
  supabase/server.ts            # RSC (anon)
  supabase/admin.ts             # service_role — import 'server-only' obligatoire
  ingest.ts                     # normalisation + upsert (cœur du brief §3.3)
  sources/transfermarkt.ts      # scraper rumeurs
  sources/apifootball.ts        # résolution visuels + cache + budget
  format.ts                     # parsing montants, emoji drapeau, temps relatif
  types.ts                      # types générés depuis Supabase
supabase/migrations/            # SQL versionné
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
- **Tête joueur** : 88 px, `rounded-full object-cover ring-2 ring-slate-800`, halo radial en couleur
  d'accent derrière (`absolute inset-0 blur-2xl opacity-25`). C'est le rendu FIFA sans détourage.
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

## 6. Variables d'environnement

```bash
NEXT_PUBLIC_SUPABASE_URL=            # public
NEXT_PUBLIC_SUPABASE_ANON_KEY=       # public, lecture seule via RLS
SUPABASE_SERVICE_ROLE_KEY=           # SERVEUR UNIQUEMENT
API_FOOTBALL_KEY=                    # serveur uniquement
CRON_SECRET=                         # serveur uniquement
```

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

## 7. Découpage en phases

| Phase | Contenu | Sortie vérifiable | Charge |
|---|---|---|---|
| **0** | Projet Supabase, migrations, RLS, Realtime, scaffold Next.js | `select` anon OK, `insert` anon refusé | 0,5 j |
| **1** | Seed 24 lignes, `MercatoCard`, `Crest`, `StatusBadge`, `ProbabilityGauge`, grille | Feed statique complet, responsive 1/2/3 col | 1 j |
| **2** | `FilterBar`, filtres + URL, Realtime + les 3 correctifs §4.2 | `insert` SQL manuel → carte qui apparaît seule | 0,5 j |
| **3** | `lib/ingest.ts`, `format.ts`, route cron, fixtures JSON | `POST /api/cron/ingest` rejouable sans doublon | 1 j |
| **4** | Scraper Transfermarkt + `sources/apifootball.ts` + `media_cache` | Vraies rumeurs avec vraies probabilités | 1 j |
| **5** | *Hors MVP* — détourage, microservice Transfermarkt, auth/favoris, push | — | — |

**Total MVP : 4 jours.**

Chaque phase est mergeable et démontrable seule. À la fin de la Phase 2, le produit est présentable
même si la donnée est fausse — c'est ce qui permet d'arbitrer le design tôt.

---

## 8. Critères d'acceptation du MVP

- [ ] Feed trié par `published_at desc`, 60 lignes, HTML rendu côté serveur (visible en JS désactivé)
- [ ] Les 4 filtres fonctionnent, sont comptés et partageables par URL
- [ ] Un `insert` en base fait apparaître une carte sans rechargement, en moins de 2 s
- [ ] Un `update` de `probability_score` anime la jauge et affiche la tendance
- [ ] Aucun doublon après 3 exécutions consécutives du cron
- [ ] Une ligne sans `player_photo` ni logo s'affiche proprement (fallback initiales)
- [ ] Aucune écriture possible avec la clé `anon` (test explicite)
- [ ] Lighthouse mobile ≥ 90 en performance et accessibilité
- [ ] Consommation API-Football en régime permanent < 20 appels/jour

---

## 9. Risques

| Risque | Impact | Traitement |
|---|---|---|
| Transfermarkt modifie son HTML | Scraper muet, feed figé | Parse tolérant, `IngestReport.scanned === 0` traité comme une erreur, alerte |
| Conditions d'utilisation Transfermarkt | Le scraping y est interdit | Volume faible, User-Agent honnête, cache 30 min, attribution + lien source sur chaque carte. À revoir si le produit sort du cadre perso. |
| CDN d'images tiers instable | Cartes cassées | `Crest` avec fallback initiales, `onError` systématique |
| Quota API-Football épuisé | Nouvelles cartes sans visuel | Compteur journalier avec coupure à 80, `miss_count` |
| Realtime plafonné (plan gratuit : 200 connexions simultanées) | Feed figé pour les derniers arrivés | Acceptable au MVP. Repli : polling 60 s si l'abonnement échoue. |
