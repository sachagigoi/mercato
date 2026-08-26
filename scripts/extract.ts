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
 *
 * `--verbose` montre ce que le modèle a répondu et les phrases qu'il a lues.
 * C'est le mode à utiliser dès qu'une extraction est rejetée : sans lui, on
 * sait qu'elle a échoué mais pas pourquoi.
 *
 * `--dry-run` n'écrit rien et affiche ce que le modèle a produit : c'est le
 * mode à utiliser tant qu'on mesure la précision. Rien ne part vers la base
 * avant d'avoir un taux de rejet regardable.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import { createBytesFetcher } from "../lib/articles.ts";
import { createOllamaExtractor } from "../lib/extract/ollama.ts";
import { rejectionRate, runSource, type ArticleOutcome } from "../lib/extract/run.ts";
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
    console.log(`        « ${c.quote.slice(0, 110)}${c.quote.length > 110 ? "…" : ""} »`);
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

async function main() {
  const dryRun = flag("dry-run");
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
