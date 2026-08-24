"use client";

import Image from "next/image";
import { useState } from "react";
import { ACCENT, type Accent } from "@/lib/accent";

type Level = "cutout" | "photo" | "silhouette";

function initialLevel(cutout: string | null, photo: string | null): Level {
  if (cutout) return "cutout";
  if (photo) return "photo";
  return "silhouette";
}

/**
 * Portrait du joueur — chaîne de repli à trois niveaux (§6.4 des specs).
 *
 *   1. player_cutout   portrait détouré, fond perdu, aligné bas
 *   2. player_photo    masque circulaire
 *   3. aucun visuel    silhouette
 *
 * À tout instant le feed contient des lignes dans les trois états : le worker de
 * détourage est asynchrone et sa porte de qualité en écarte volontairement une
 * partie. La carte doit donc paraître intentionnelle dans les trois cas — c'est
 * une contrainte de design, pas une dégradation à tolérer.
 *
 * Une image cassée redescend d'un niveau au lieu d'afficher un cadre vide.
 */
export function PlayerPortrait({
  name,
  cutout,
  photo,
  accent,
}: {
  name: string;
  cutout: string | null;
  photo: string | null;
  accent: Accent;
}) {
  const [level, setLevel] = useState<Level>(() => initialLevel(cutout, photo));
  const a = ACCENT[accent];

  const degrade = () =>
    setLevel((current) => (current === "cutout" && photo ? "photo" : "silhouette"));

  return (
    <div className="relative h-24 w-[88px] shrink-0">
      {/* Halo d'accent : donne du volume au portrait et rattache la carte à son type. */}
      <span
        aria-hidden
        className={`absolute inset-x-1 bottom-1 h-[68px] rounded-full opacity-25 blur-2xl ${a.halo}`}
      />

      {level === "cutout" && cutout && (
        <Image
          src={cutout}
          alt={name}
          fill
          sizes="88px"
          onError={degrade}
          // Le détouré doit dominer le masque circulaire, pas paraître plus petit :
          // c'est lui qui porte le rendu carte. L'agrandissement part du bas pour
          // rester ancré, et déborde dans le padding sans jamais toucher l'en-tête.
          className="origin-bottom scale-110 object-contain object-bottom drop-shadow-[0_6px_10px_rgba(0,0,0,0.55)]"
          unoptimized
        />
      )}

      {level === "photo" && photo && (
        <Image
          src={photo}
          alt={name}
          width={80}
          height={80}
          onError={degrade}
          className="absolute bottom-1 left-1/2 size-20 -translate-x-1/2 rounded-full object-cover ring-2 ring-slate-800"
          unoptimized
        />
      )}

      {level === "silhouette" && (
        <span
          aria-label={name}
          className="absolute bottom-1 left-1/2 grid size-20 -translate-x-1/2 place-items-end overflow-hidden rounded-full bg-slate-800 ring-2 ring-slate-800"
        >
          <svg viewBox="0 0 60 52" className="w-[46px] fill-slate-600" aria-hidden>
            <circle cx="30" cy="16" r="12.5" />
            <path d="M4 52c0-13.8 11.6-21.5 26-21.5S56 38.2 56 52z" />
          </svg>
        </span>
      )}
    </div>
  );
}
