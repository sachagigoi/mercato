import * as cheerio from "cheerio";

import type { Article, BytesFetcher, FeedItem, PressSource } from "../articles.ts";

export const MAXIFOOT_FEED = "http://rss.maxifoot.com/football-transfert.xml";

/**
 * Le site est servi en ISO-8859-1, y compris le flux d'articles.
 *
 * Décoder en UTF-8 par défaut donnerait « brÃ¨ve » au lieu de « brève », et
 * comme le garde-fou d'extraction vérifie que la citation figure littéralement
 * dans l'article, un texte mal décodé ferait rejeter des extractions correctes.
 * Le flux RSS, lui, s'annonce bien en UTF-8 : les deux ne se traitent pas pareil.
 */
const ARTICLE_CHARSET = "iso-8859-1";
const FEED_CHARSET = "utf-8";

const decode = (bytes: Uint8Array, charset: string) =>
  new TextDecoder(charset).decode(bytes);

/**
 * Flux RSS 2.0 standard : title, link, description, pubDate, guid.
 *
 * On lit avec cheerio en mode XML plutôt qu'au regex : `description` contient
 * du HTML échappé, et les titres portent des entités (« Barça », « 9,3 M€ »)
 * qu'un découpage manuel rendrait mal.
 */
export function parseFeed(xml: string): FeedItem[] {
  const $ = cheerio.load(xml, { xml: true });

  return $("item")
    .map((_, el): FeedItem | null => {
      const item = $(el);
      const url = item.find("link").first().text().trim();
      const title = item.find("title").first().text().trim();
      if (!url || !title) return null;

      const guid = item.find("guid").first().text().trim() || url;
      const teaser = item.find("description").first().text().trim();
      const date = new Date(item.find("pubDate").first().text().trim());

      return {
        guid,
        url,
        // Tous les titres du flux sont préfixés « Mercato {Club} : ». Le préfixe
        // n'apporte rien au sens et coûterait des tokens à chaque extraction,
        // mais le club sujet, lui, est un indice qu'on garde plus bas.
        title,
        teaser: teaser || null,
        publishedAt: Number.isNaN(date.getTime()) ? null : date,
      };
    })
    .get()
    .filter((item): item is FeedItem => item !== null);
}

/** « Mercato Lille : Bouaddi à City pour 100 M€ » -> { club: 'Lille', reste: '…' }. */
export function splitTitle(title: string): { club: string | null; headline: string } {
  const m = /^Mercato\s+([^:]+?)\s*:\s*(.+)$/s.exec(title.replace(/\s+/g, " ").trim());
  if (!m) return { club: null, headline: title.replace(/\s+/g, " ").trim() };
  return { club: m[1].trim(), headline: m[2].trim() };
}

/**
 * Corps de l'article.
 *
 * Le texte vit dans `<div id=btxt1>`, avec des encarts publicitaires injectés
 * en plein milieu sous forme de `<div>` imbriqués — ils portent du texte
 * (« emplacement publicitaire ») qui se retrouverait dans le corps si on se
 * contentait de retirer les balises. On les supprime donc en tant que nœuds,
 * ce que cheerio fait proprement là où une expression régulière butait sur
 * l'imbrication.
 *
 * `<b id=momo>` marque la fin de la brève ; ce qui suit est de la navigation.
 */
export function parseArticle(html: string): { title: string; text: string; playerHints: Article["playerHints"] } {
  const $ = cheerio.load(html);

  const title = $("h1").first().text().replace(/\s+/g, " ").trim();

  const body = $("#btxt1");
  if (body.length === 0) return { title, text: "", playerHints: [] };

  // Les noms balisés sont relevés AVANT le nettoyage : ils vivent dans des
  // <span> que le passage au texte ferait disparaître.
  const playerHints: Article["playerHints"] = [];
  body.find("span[data-idj]").each((_, el) => {
    const sourceId = $(el).attr("data-idj")?.trim();
    const name = $(el).text().replace(/\s+/g, " ").trim();
    if (sourceId && name) playerHints.push({ sourceId, name });
  });

  body.find("div, script, style, ins, iframe").remove();

  const text = body
    .text()
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { title, text, playerHints };
}

export function createMaxifoot(http: BytesFetcher): PressSource {
  return {
    name: "Maxifoot",
    // Agrégateur : il relaie beaucoup (Sky, L'Équipe, Fabrizio Romano) et
    // sourcerait rarement en propre. Utile pour la couverture et les montants
    // cités, mais deux articles Maxifoot ne valent pas deux confirmations.
    tier: 1,

    async listRecent() {
      return parseFeed(decode(await http.get(MAXIFOOT_FEED), FEED_CHARSET));
    },

    async fetchArticle(item) {
      const html = decode(await http.get(item.url), ARTICLE_CHARSET);
      const parsed = parseArticle(html);
      return {
        source: "Maxifoot",
        guid: item.guid,
        url: item.url,
        // Le h1 de la page est plus propre que le titre du flux : il n'a pas le
        // préfixe « Mercato ». On retombe sur le flux si la page a changé.
        title: parsed.title || splitTitle(item.title).headline,
        text: parsed.text,
        publishedAt: item.publishedAt,
        playerHints: parsed.playerHints,
      };
    },
  };
}
