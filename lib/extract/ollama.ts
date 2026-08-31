import { OLLAMA_FORMAT } from "./claims.ts";

/**
 * Client Ollama, réduit à ce dont l'extraction a besoin.
 *
 * Injecté partout comme `HtmlFetcher` l'est pour les scrapers : le pipeline se
 * teste intégralement contre des réponses enregistrées, sans modèle ni réseau.
 */
export interface Extractor {
  /**
   * Rend la sortie brute du modèle. La validation est le travail du garde-fou.
   *
   * `mentions` est la liste des clubs de Ligue 1 que le préfiltre a déjà
   * trouvés dans le texte. On la calculait sans s'en servir ; la donner au
   * modèle coûte cinq tokens et lui évite le raté le plus fréquent — laisser
   * `fromClub` à null alors que le club vendeur est dans le titre.
   */
  extract(sentences: readonly string[], mentions?: readonly string[]): Promise<{ claims: unknown[]; raw: string }>;
  readonly model: string;
  /** Version de l'extraction — consigne **et** garde-fou. Stockée avec chaque
   *  déclaration : sans elle, impossible d'expliquer pourquoi une carte
   *  affichait 50 M€ la semaine dernière. */
  readonly promptVersion: string;
}

export const PROMPT_VERSION = "7";

/**
 * Le modèle demandé n'est pas installé sur cette machine.
 *
 * Distincte d'une erreur d'extraction ordinaire, et pour une raison concrète :
 * elle ne se réparera pas à l'article suivant. Un passage réel a produit cinq
 * fois « Ollama : HTTP 404 » — cinq pages téléchargées chez la source pour
 * rien, et un message qui ne disait pas quoi faire.
 */
export class MissingModelError extends Error {
  readonly model: string;

  // Champ déclaré puis assigné, et non une propriété de paramètre : celles-ci
  // ne sont pas du typage mais de la génération de code, et `--experimental-
  // strip-types` les refuse à l'exécution — là où `tsc` les accepte.
  constructor(model: string) {
    super(
      `Modèle « ${model} » absent de cette machine.\n` +
        `  Installe-le d'abord :  ollama pull ${model}`,
    );
    this.model = model;
    this.name = "MissingModelError";
  }
}

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
  "Rends une entrée par transfert évoqué, ou une liste vide s'il n'y en a aucun.",
  "",
  "sentence : le NUMÉRO de la phrase qui énonce le transfert. Préfère une",
  "           phrase du corps plutôt que le titre.",
  "feeSentence : le NUMÉRO de la phrase qui contient le montant, si ce n'est",
  "           pas la même. null sinon.",
  "player   : le nom du joueur.",
  "fromClub : le club où le joueur joue AUJOURD'HUI, celui qu'il quitterait.",
  "           Un joueur en a toujours un, et l'article le nomme presque",
  "           toujours — y compris quand c'est un club étranger. null doit",
  "           rester rare.",
  "toClub   : le club qui le veut, ou qui vient de le recruter.",
  "           On te donne les clubs de Ligue 1 cités : la brève vient d'un flux",
  "           mercato français, l'un d'eux est presque toujours l'un des deux.",
  "           Si deux clubs se disputent le joueur, rends UNE ENTRÉE PAR CLUB.",
  "feeText  : le montant RECOPIÉ MOT POUR MOT de cette phrase — « 100 M€ »,",
  "           « 18 millions d'euros ». Ne convertis rien, ne calcule rien.",
  "           null si la phrase ne contient aucun montant.",
  "qualifier: exact, ou environ / minimum / maximum si l'article le nuance.",
  "feeKind  : transfert, pret, pret_avec_option, clause, libre, inconnu.",
  "stance   : où en est le dossier —",
  "           rumeur      un intérêt est évoqué",
  "           discussions des négociations sont en cours",
  "           accord      un accord est trouvé, rien n'est encore signé",
  "           officiel    le transfert est annoncé par le club",
  "           dementi     l'article affirme que l'information est FAUSSE",
  "",
  "La plupart des brèves n'annoncent aucun montant : feeText à null est le cas",
  "normal, pas un échec.",
  "",
  "Un transfert SANS montant compte autant qu'un autre : une signature libre,",
  "une fin de contrat, une arrivée annoncée sans chiffre. Rends-la quand même,",
  "avec feeText à null. Ne rends une liste vide que si l'article ne parle",
  "d'aucun mouvement de joueur.",
].join("\n");

export const buildUserPrompt = (
  sentences: readonly string[],
  mentions: readonly string[] = [],
) => {
  const numbered = sentences.map((s, i) => `[${i}] ${s}`).join("\n");
  // En tête, pas en queue : sur un CPU, ce que le modèle lit en dernier pèse
  // moins que ce qu'il lit avant le texte à analyser.
  return mentions.length > 0
    ? `Clubs de Ligue 1 cités : ${mentions.join(", ")}.\n\n${numbered}`
    : numbered;
};

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

    async extract(sentences, mentions) {
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
            { role: "user", content: buildUserPrompt(sentences, mentions) },
          ],
        }),
      });

      // 404 sur /api/chat ne veut pas dire « endpoint introuvable » : Ollama
      // le rend quand le MODÈLE n'existe pas localement. Le message brut
      // envoyait chercher au mauvais endroit.
      if (res.status === 404) throw new MissingModelError(model);
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
