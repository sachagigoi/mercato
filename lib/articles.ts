/**
 * Contrat commun à toutes les sources de presse.
 *
 * Une source se réduit à deux fonctions : lister ce qui est nouveau, et rendre
 * le texte d'un article. Tout ce qui suit — préfiltre, extraction, garde-fou,
 * résolution — travaille sur `Article` et ne sait rien de Maxifoot.
 *
 * C'est le point qui rend la deuxième source moins chère que la première : elle
 * n'apporte qu'un parseur, pas un pipeline.
 */

/** Entrée de flux : ce que le RSS donne, avant d'aller chercher l'article. */
export type FeedItem = {
  /** Clé naturelle de l'article chez la source. Sert à ne pas le relire deux fois. */
  guid: string;
  url: string;
  title: string;
  /** Chapô du flux. Souvent tronqué, mais parfois suffisant. */
  teaser: string | null;
  publishedAt: Date | null;
};

/** Article complet, prêt pour le préfiltre. */
export type Article = {
  source: string;
  guid: string;
  url: string;
  title: string;
  /** Corps en texte brut, sans balises ni encarts publicitaires. */
  text: string;
  publishedAt: Date | null;
  /**
   * Identifiants de joueurs annotés par la source, quand elle en fournit.
   *
   * Maxifoot balise les noms (`<span data-idj=245910>Barcola</span>`), ce qui
   * donne une clé stable là où le texte ne donne qu'un nom de famille. C'est un
   * indice, jamais une garantie : la moitié des articles n'en portent pas.
   */
  playerHints: { sourceId: string; name: string }[];
};

export interface PressSource {
  /** Nom court, tel qu'il sera stocké et affiché sur la carte. */
  readonly name: string;
  /** Poids de fiabilité, cf. §. 1 = agrégateur, 3 = source de référence. */
  readonly tier: number;
  listRecent(): Promise<FeedItem[]>;
  fetchArticle(item: FeedItem): Promise<Article>;
}

/**
 * Accès HTTP renvoyant des octets bruts, et non une chaîne.
 *
 * La presse française est encore largement en ISO-8859-1 — Maxifoot l'est.
 * Laisser `fetch` deviner l'encodage casse les accents, et un texte aux accents
 * cassés fait échouer le garde-fou de citation sur des phrases pourtant justes.
 * Le décodage appartient donc au parseur de la source, qui connaît son charset.
 */
export interface BytesFetcher {
  get(url: string): Promise<Uint8Array>;
}

export function createBytesFetcher(userAgent: string): BytesFetcher {
  return {
    async get(url) {
      const res = await fetch(url, { headers: { "User-Agent": userAgent } });
      if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
