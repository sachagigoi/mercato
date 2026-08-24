"use client";

import Image from "next/image";
import { useState } from "react";
import { clubInitials } from "@/lib/format";

/**
 * Écusson de club, avec repli sur les initiales.
 *
 * Le repli n'est pas optionnel : les logos viennent d'un CDN tiers et une URL
 * finit toujours par casser. `onError` couvre le lien mort, le test sur `logo`
 * couvre la ligne sans visuel — les deux cas doivent rendre quelque chose de
 * volontaire, pas une image brisée.
 */
export function Crest({
  name,
  logo,
  size = 30,
}: {
  name: string | null;
  logo: string | null;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  const label = name ?? "Club inconnu";

  if (!logo || broken) {
    return (
      <span
        aria-label={label}
        title={label}
        className="grid shrink-0 place-items-center rounded-full bg-slate-800 font-semibold tracking-tight text-slate-400 ring-1 ring-slate-700/60"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.32) }}
      >
        {clubInitials(name)}
      </span>
    );
  }

  return (
    <Image
      src={logo}
      alt={label}
      title={label}
      width={size}
      height={size}
      onError={() => setBroken(true)}
      className="shrink-0 object-contain"
      style={{ width: size, height: size }}
      unoptimized
    />
  );
}
