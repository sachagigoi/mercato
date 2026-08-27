/**
 * Passage d'extraction, à lancer sur le mini PC.
 *
 * Hors du bundle Next.js, comme `cutout.py` : ce script tourne là où vit
 * Ollama, pas sur Vercel. Il ne lit aucun secret d'application — au pire l'URL
 * et le jeton de l'endpoint d'ingestion, quand on branchera l'envoi.
 *
 *   node --experimental-strip-types scripts/extract.ts --dry-run
 *   node --experimental-strip-types scripts/extract.ts --dry-run --verbose
 *   node --experimental-strip-types scripts/extract.ts --limit 5 --out claims.jsonl
 *   node --experimental-strip-types scripts/extract.ts --send
 *
 * `--verbose` montre ce que le modèle a répondu et les phrases qu'il a lues.
 * C'est le mode à utiliser dès qu'une extraction est rejetée : sans lui, on
 * sait qu'elle a échoué mais pas pourquoi.
 *
 * `--dry-run` n'écrit rien et affiche ce que le modèle a produit : c'est le
 * mode à utiliser tant qu'on mesure la précision. C'est le DÉFAUT de fait :
 * sans `--send`, aucune déclaration ne part vers la base. L'envoi se demande,
 * il ne se subit pas — rien ne doit atterrir en base avant qu'on ait un taux
 * de rejet regardable, mesuré sur de vrais articles.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import { createBytesFetcher, type PressSource } from "../lib/articles.ts";
import { createOllamaExtractor, type Extractor } from "../lib/extract/ollama.ts";
import {
  rejectionRate,
  runSource,
  toPublishPayload,
  type ArticleOutcome,
  type RunReport,
} from "../lib/extract/run.ts";
import { createMaxifoot } from "../lib/sources/maxifoot.ts";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** Journal des articles déjà vus. Un fichier suffit : c'est une liste de clés. */
const SEEN_FILE = process.env.MERCATO_SEEN ?? ".mercato-seen.json";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function loadSeen(): Set<string> {
  if (!existsSync(SEEN_FILE)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(SEEN_FILE, "utf-8")) as string[]);
  } catch {
    // Un journal illisible ne doit pas bloquer un passage : on repart à vide,
    // quitte à relire quelques articles. L'inverse — s'arrêter — coûterait
    // plus cher que le travail refait.
    return new Set();
  }
}

const cut = (s: string, n = 110) => (s.length > n ? `${s.slice(0, n)}…` : s);

const euros = (n: number | null) =>
  n === null ? "—" : new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);

function show(o: ArticleOutcome, verbose: boolean) {
  if (o.skipped) {
    console.log(`  ⨯ ${o.skipped.padEnd(13)} ${o.article.title}`);
    return;
  }
  console.log(`\n  ▸ ${o.article.title}  (${(o.ms / 1000).toFixed(1)} s)`);
  for (const c of o.claims) {
    const route = `${c.fromClubRaw ?? "?"} → ${c.toClubRaw ?? "?"}`;
    console.log(`      ✓ ${c.player} · ${route}`);
    console.log(`        ${euros(c.feeEur)} · ${c.feeKind} · ${c.stance}${c.playerInQuote ? "" : " · nom hors citation"}`);
    console.log(`        « ${cut(c.quote)} »`);
    // Le montant vit souvent dans une autre phrase que le transfert. La
    // montrer permet de vérifier d'un coup d'œil que le chiffre vient bien
    // de là où le modèle le dit.
    if (c.feeQuote && c.feeQuote !== c.quote) console.log(`        montant « ${cut(c.feeQuote)} »`);
  }
  for (const r of o.rejected) {
    console.log(`      ✗ rejeté : ${r.reason}`);
    // Le rejet seul ne dit pas POURQUOI le modèle s'est trompé. Sans ce que
    // le modèle a répondu et sans les phrases qu'il a lues, on corrige à
    // l'aveugle — c'est ce qui manquait au premier passage réel.
    if (verbose) console.log(`        reçu : ${JSON.stringify(r.raw)}`);
  }

  if (verbose) {
    console.log("        — phrases soumises —");
    o.sentences.forEach((s, i) => console.log(`        [${i}] ${s.slice(0, 100)}`));
    if (o.claims.length === 0 && o.rejected.length === 0) {
      console.log(`        — réponse brute — ${o.raw.slice(0, 400)}`);
    }
  }
}


/**
 * Envoie les déclarations retenues à `/api/claims`.
 *
 * Le worker n'a aucun accès à la base : il parle à un endpoint, qui valide,
 * résout et écrit. C'est cette frontière qui rend le mini PC remplaçable — et
 * qui fait qu'un secret volé ici ne donne pas les clés de la base.
 */
async function send(report: RunReport, source: PressSource, extractor: Extractor) {
  const url = process.env.MERCATO_URL;
  const secret = process.env.CRON_SECRET;
  if (!url || !secret) {
    throw new Error("MERCATO_URL et CRON_SECRET sont requis pour --send.");
  }

  const payload = toPublishPayload(report, {
    source: source.name,
    tier: source.tier,
    model: extractor.model,
    promptVersion: extractor.promptVersion,
  });

  if (payload.articles.length === 0) {
    console.log("  → rien à envoyer");
    return;
  }

  const res = await fetch(`${url.replace(/\/$/, "")}/api/claims`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify(payload),
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`envoi : HTTP ${res.status} ${body.slice(0, 200)}`);
  console.log(`  → envoyé : ${body}`);
}

async function main() {
  const dryRun = flag("dry-run");
  const sending = flag("send");
  const verbose = flag("verbose");
  const limit = Number(arg("limit", "20"));
  const out = arg("out");

  const source = createMaxifoot(createBytesFetcher(USER_AGENT));
  const extractor = createOllamaExtractor({ model: arg("model") });
  const seen = loadSeen();

  console.log(`source ${source.name} · modèle ${extractor.model} · ${seen.size} articles déjà vus`);
  if (dryRun) console.log("mode sec : rien ne sera écrit\n");

  const report = await runSource(source, extractor, {
    seen, limit, onArticle: (o) => show(o, verbose),
  });

  const seconds = report.msTotal / 1000;
  console.log(`
─────────────────────────────────────────────
  ${report.listed} au flux → ${report.fetched} récupérés → ${report.extracted} soumis au modèle
  ${report.claims} déclarations retenues · ${report.rejected} rejetées · ${report.outOfScope} hors périmètre
  taux de rejet ${(rejectionRate(report) * 100).toFixed(0)} %
  ${seconds.toFixed(0)} s de modèle${report.extracted ? ` · ${(seconds / report.extracted).toFixed(0)} s par article` : ""}`);
  for (const e of report.errors) console.log(`  ! ${e}`);

  if (dryRun) return;

  // L'envoi précède l'écriture du journal : un lot refusé par le serveur doit
  // pouvoir être rejoué au passage suivant, pas être marqué comme traité.
  if (sending) await send(report, source, extractor);

  if (out) {
    for (const o of report.outcomes) {
      for (const c of o.claims) {
        appendFileSync(out, JSON.stringify({
          source: o.article.source, url: o.article.url, guid: o.article.guid,
          publishedAt: o.article.publishedAt, model: extractor.model,
          promptVersion: extractor.promptVersion, ...c,
        }) + "\n");
      }
    }
    console.log(`  → ${out}`);
  }

  // Le journal n'est écrit qu'en fin de passage réussi : une interruption doit
  // faire retenter les articles, pas les perdre en silence.
  for (const o of report.outcomes) seen.add(o.article.guid);
  writeFileSync(SEEN_FILE, JSON.stringify([...seen], null, 0));
}

main().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : cause);
  process.exit(1);
});
