#!/usr/bin/env python3
"""
Worker de détourage des portraits (§6 des specs).

Vide la file `media_cache` : télécharge le portrait, retire le fond, recadre,
stocke le PNG dans Supabase Storage, puis propage l'URL sur les lignes
`transfers` concernées — ce dernier UPDATE déclenche Realtime, donc la tête
détourée apparaît en direct sur les cartes déjà ouvertes.

Tourne sur GitHub Actions plutôt que sur Vercel : le modèle pèse une centaine
de mégaoctets et réclame plusieurs secondes par image, ce qui ne tient pas dans
une fonction serverless. Le job n'est pas critique en latence — la carte
s'affiche avec le masque circulaire en attendant.

Usage :
    python scripts/cutout.py [--limit 40] [--dry-run]

Variables d'environnement requises :
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
"""

from __future__ import annotations

import argparse
import io
import os
import sys
from dataclasses import dataclass, field

import httpx
from PIL import Image

# `rembg` et son runtime ONNX mettent une trentaine de secondes à se charger.
# L'import est donc différé jusqu'après la vérification de l'environnement :
# sans ça, un secret manquant met 33 s à se signaler au lieu d'une fraction
# de seconde — constaté sur un vrai run GitHub Actions.

# --- Réglages ---------------------------------------------------------------

BUCKET = "cutouts"
MODEL = "isnet-general-use"

# Porte de qualité. En dessous, le détourage donne des contours en dents de
# scie, franchement pires que le masque circulaire du front. Mesuré sur les
# portraits Transfermarkt : `/portrait/medium/` fait 100x130 (rejeté),
# `/portrait/big/` fait 300x390 (accepté).
MIN_SOURCE_PX = 200

# Cadre de sortie. Carré : la carte l'affiche dans une boîte fixe et un ratio
# constant évite de recalculer la mise en page par joueur.
OUTPUT_PX = 320

# Trois échecs et la ligne sort de la file. Aligné sur la requête `listPending`
# du store TypeScript, qui filtre déjà sur `miss_count < 3`.
MAX_ATTEMPTS = 3

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)


@dataclass
class Report:
    scanned: int = 0
    done: int = 0
    skipped: int = 0
    failed: int = 0
    propagated: int = 0
    errors: list[str] = field(default_factory=list)

    def as_line(self) -> str:
        return (
            f"scannés={self.scanned} détourés={self.done} écartés={self.skipped} "
            f"échecs={self.failed} propagés={self.propagated}"
        )


class Supabase:
    """Accès REST minimal. Évite d'embarquer le SDK pour six requêtes."""

    def __init__(self, url: str, service_key: str) -> None:
        self.url = url.rstrip("/")
        self.key = service_key
        self.client = httpx.Client(
            timeout=30,
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
            },
        )

    def pending(self, limit: int) -> list[dict]:
        """Portraits en attente : jamais détourés, pas encore condamnés."""
        r = self.client.get(
            f"{self.url}/rest/v1/media_cache",
            params={
                "select": "kind,name_normalized,image_url,cutout_status,cutout_attempts",
                "kind": "eq.player",
                "cutout_status": "eq.pending",
                "cutout_attempts": f"lt.{MAX_ATTEMPTS}",
                "image_url": "not.is.null",
                "order": "fetched_at.asc",
                "limit": str(limit),
            },
        )
        r.raise_for_status()
        return r.json()

    def upload(self, path: str, data: bytes) -> str:
        """Dépose l'image et renvoie son URL publique."""
        r = self.client.post(
            f"{self.url}/storage/v1/object/{BUCKET}/{path}",
            content=data,
            headers={
                "Content-Type": "image/png",
                # Immuable : le nom de fichier porte déjà l'identité du joueur,
                # un remplacement passe par `x-upsert` et invalide le cache CDN.
                "Cache-Control": "public, max-age=31536000, immutable",
                "x-upsert": "true",
            },
        )
        r.raise_for_status()
        return f"{self.url}/storage/v1/object/public/{BUCKET}/{path}"

    def mark(self, name: str, status: str, cutout_url: str | None = None) -> None:
        payload: dict[str, object] = {"cutout_status": status}
        if cutout_url:
            payload["cutout_url"] = cutout_url
        if status == "failed":
            payload["cutout_status"] = "pending"  # rejouable jusqu'au plafond

        r = self.client.patch(
            f"{self.url}/rest/v1/media_cache",
            params={"kind": "eq.player", "name_normalized": f"eq.{name}"},
            json=payload,
        )
        r.raise_for_status()

    def bump_attempts(self, name: str, current: int) -> None:
        r = self.client.patch(
            f"{self.url}/rest/v1/media_cache",
            params={"kind": "eq.player", "name_normalized": f"eq.{name}"},
            json={"cutout_attempts": current + 1},
        )
        r.raise_for_status()

    def propagate(self, name_normalized: str, cutout_url: str) -> int:
        """
        Écrit `player_cutout` sur les transferts du joueur.

        C'est cet UPDATE qui rend le worker visible : Realtime le diffuse, et la
        tête détourée remplace la silhouette sur les cartes déjà affichées, sans
        rechargement. Sans cette étape, il faudrait attendre un F5.

        Le rapprochement se fait sur le nom normalisé côté SQL, via une fonction
        dédiée — PostgREST ne sait pas exprimer `normalize(player_name) = ...`.
        """
        r = self.client.post(
            f"{self.url}/rest/v1/rpc/apply_player_cutout",
            json={"p_name_normalized": name_normalized, "p_cutout_url": cutout_url},
        )
        r.raise_for_status()
        return int(r.json() or 0)


def normalize_name(value: str) -> str:
    """Réplique exacte de `normalizeName()` côté TypeScript."""
    import unicodedata

    decomposed = unicodedata.normalize("NFD", value)
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    lowered = stripped.lower()
    cleaned = "".join(c if c.isalnum() else " " for c in lowered)
    return " ".join(cleaned.split())


def fetch_image(url: str) -> Image.Image:
    r = httpx.get(url, timeout=30, headers={"User-Agent": USER_AGENT}, follow_redirects=True)
    r.raise_for_status()
    return Image.open(io.BytesIO(r.content)).convert("RGBA")


def cut_out(source: Image.Image, session) -> Image.Image:
    """
    Retire le fond, rogne sur le sujet, puis compose un carré.

    Le rognage sur la bounding box alpha est ce qui rend le cadrage prévisible :
    sans lui, un sujet excentré ou entouré de vide s'afficherait tout petit dans
    la boîte de la carte.
    """
    from rembg import remove

    cut = remove(
        source,
        session=session,
        alpha_matting=True,
        alpha_matting_foreground_threshold=240,
    )

    bbox = cut.getbbox()
    if bbox:
        cut = cut.crop(bbox)

    # Mise à l'échelle dans le carré, sujet posé sur le bas : c'est l'ancrage
    # bas qui donne le rendu « carte », le buste sortant du cadre.
    ratio = min(OUTPUT_PX / cut.width, OUTPUT_PX / cut.height)
    resized = cut.resize(
        (max(1, round(cut.width * ratio)), max(1, round(cut.height * ratio))),
        Image.LANCZOS,
    )

    canvas = Image.new("RGBA", (OUTPUT_PX, OUTPUT_PX), (0, 0, 0, 0))
    canvas.alpha_composite(resized, ((OUTPUT_PX - resized.width) // 2, OUTPUT_PX - resized.height))
    return canvas


def process(db: Supabase, session, item: dict, report: Report, dry_run: bool) -> None:
    name = item["name_normalized"]
    url = item["image_url"]

    try:
        source = fetch_image(url)
    except Exception as exc:  # noqa: BLE001 — une source injoignable ne doit pas tout arrêter
        report.failed += 1
        report.errors.append(f"{name} : téléchargement — {exc}")
        if not dry_run:
            db.bump_attempts(name, item.get("cutout_attempts", 0))
        return

    if min(source.size) < MIN_SOURCE_PX:
        report.skipped += 1
        print(f"  ~ {name} : source {source.width}x{source.height}, sous la porte de {MIN_SOURCE_PX}px")
        if not dry_run:
            db.mark(name, "skipped")
        return

    try:
        result = cut_out(source, session)
        buffer = io.BytesIO()
        result.save(buffer, format="PNG", optimize=True)
        data = buffer.getvalue()
    except Exception as exc:  # noqa: BLE001
        report.failed += 1
        report.errors.append(f"{name} : détourage — {exc}")
        if not dry_run:
            db.bump_attempts(name, item.get("cutout_attempts", 0))
        return

    if dry_run:
        report.done += 1
        print(f"  = {name} : {len(data) // 1024} Ko (essai à blanc, rien n'est écrit)")
        return

    try:
        cutout_url = db.upload(f"{name.replace(' ', '-')}.png", data)
        db.mark(name, "done", cutout_url)
        touched = db.propagate(name, cutout_url)
        report.done += 1
        report.propagated += touched
        print(f"  + {name} : {len(data) // 1024} Ko, {touched} carte(s) mise(s) à jour")
    except Exception as exc:  # noqa: BLE001
        report.failed += 1
        report.errors.append(f"{name} : dépôt — {exc}")
        db.bump_attempts(name, item.get("cutout_attempts", 0))


def main() -> int:
    parser = argparse.ArgumentParser(description="Détourage des portraits en attente")
    parser.add_argument("--limit", type=int, default=40, help="portraits traités par passage")
    parser.add_argument("--dry-run", action="store_true", help="ne rien écrire")
    args = parser.parse_args()

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        print("SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis.", file=sys.stderr)
        return 2

    db = Supabase(url, key)
    report = Report()

    items = db.pending(args.limit)
    report.scanned = len(items)
    if not items:
        print("File vide, rien à faire.")
        return 0

    print(f"{len(items)} portrait(s) en attente. Chargement du modèle {MODEL}…")
    from rembg import new_session

    session = new_session(MODEL)

    for item in items:
        process(db, session, item, report, args.dry_run)

    print(f"\n{report.as_line()}")
    for err in report.errors[:10]:
        print(f"  ! {err}", file=sys.stderr)

    # Un échec isolé ne fait pas échouer le job : la ligne sera reprise au
    # passage suivant, et le feed reste complet grâce au repli du front.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
