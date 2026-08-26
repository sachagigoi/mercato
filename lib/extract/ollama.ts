import { OLLAMA_FORMAT } from "./claims.ts";

/**
 * Client Ollama, réduit à ce dont l'extraction a besoin.
 *
 * Injecté partout comme `HtmlFetcher` l'est pour les scrapers : le pipeline se
 * teste intégralement contre des réponses enregistrées, sans modèle ni réseau.
 */
export interface Extractor {
  /** Rend la sortie brute du modèle. La validation est le travail du garde-fou. */
  extract(sentences: readonly string[]): Promise<{ claims: unknown[]; raw: string }>;
  readonly model: string;
  /** Version du prompt, stockée avec chaque déclaration. Sans elle, impossible
   *  d'expliquer pourquoi une carte affichait 50 M€ la semaine dernière. */
  readonly promptVersion: string;
}

export const PROMPT_VERSION = "1";

/**
 * Consigne système, volontairement courte et **strictement identique** d'un
 * appel à l'autre.
 *
 * Deux raisons. Son préfixe est mis en cache par llama.cpp tant que le modèle
 * reste chargé : la changer d'un caractère fait repayer son prefill à chaque
 * article — à 14 tokens/s sur un CPU, ça se compte en dizaines de secondes.
 * Et le schéma n'a pas à y être décrit : `format` le contraint déjà au
 * décodage, le répéter en prose ne ferait que coûter des tokens.
 */
export const SYSTEM_PROMPT = [
  "Tu extrais les informations de transfert d'une brève de football française.",
  "On te donne les phrases de l'article, numérotées à partir de 0.",
  "Rends une entrée par transfert évoqué.",
  "`sentence` est le NUMÉRO de la phrase d'où vient l'information.",
  "`feeEur` est le montant en euros, et UNIQUEMENT s'il est écrit dans l'article.",
  "N'invente jamais de montant : sans chiffre écrit, omets `feeEur`.",
].join("\n");

export const buildUserPrompt = (sentences: readonly string[]) =>
  sentences.map((s, i) => `[${i}] ${s}`).join("\n");

export type OllamaOptions = {
  endpoint?: string;
  model?: string;
  /** Injecté pour les tests ; `globalThis.fetch` en production. */
  fetchImpl?: typeof fetch;
};

export function createOllamaExtractor(options: OllamaOptions = {}): Extractor {
  const endpoint = options.endpoint ?? process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
  const model = options.model ?? process.env.OLLAMA_MODEL ?? "qwen2.5:7b-instruct-q4_K_M";
  const doFetch = options.fetchImpl ?? fetch;

  return {
    model,
    promptVersion: PROMPT_VERSION,

    async extract(sentences) {
      const res = await doFetch(`${endpoint}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          // Le décodage contraint : la sortie est garantie conforme au schéma.
          // C'est ce qui permet à un petit modèle de tenir le rôle — on ne lui
          // demande plus de bien se tenir, on l'en empêche.
          format: OLLAMA_FORMAT,
          // Le modèle reste résident entre deux articles. Sans ça, on paie
          // près de sept secondes de rechargement à chaque appel.
          keep_alive: "30m",
          options: {
            // Extraction, pas rédaction : aucune raison de laisser du hasard.
            // Et une sortie déterministe rend le banc d'essai reproductible.
            temperature: 0,
            seed: 1,
            num_predict: 512,
          },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt(sentences) },
          ],
        }),
      });

      if (!res.ok) throw new Error(`Ollama : HTTP ${res.status}`);

      const body = (await res.json()) as { message?: { content?: string } };
      const raw = body.message?.content ?? "";

      // Malgré le décodage contraint, on ne fait pas confiance au parse : un
      // modèle interrompu par `num_predict` rend du JSON tronqué. Une réponse
      // illisible vaut zéro déclaration, jamais une exception qui ferait
      // tomber tout le lot.
      try {
        const parsed = JSON.parse(raw) as { claims?: unknown };
        return { claims: Array.isArray(parsed.claims) ? parsed.claims : [], raw };
      } catch {
        return { claims: [], raw };
      }
    },
  };
}
