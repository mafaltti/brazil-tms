import { DateTime } from "luxon";

/**
 * Art shown on the login screen's left panel (TMS-115). The default truck photo is swapped for a
 * campaign piece during its month and comes back on its own when the month ends — no deploy needed
 * to switch either way. Months are evaluated in America/Sao_Paulo, the operation's timezone.
 */
export interface LoginArt {
  id: string;
  /** Public path under apps/web/public. Must keep the 888:499 ratio of the panel frame. */
  src: string;
}

export const DEFAULT_LOGIN_ART: LoginArt = {
  id: "padrao",
  src: "/marca/banco-mercedez-benz-1.avif",
};

interface Campaign extends LoginArt {
  /** Calendar month (1-12) during which the campaign art replaces the default. */
  month: number;
}

export const LOGIN_CAMPAIGNS: readonly Campaign[] = [
  // Outubro Rosa — breast cancer awareness, the whole of October.
  { id: "outubro-rosa", month: 10, src: "/marca/outubro-rosa.avif" },
];

const ZONE = "America/Sao_Paulo";

/**
 * Picks the art for `now`. `preview` (the `?arte=` query param) forces a given art so the campaign
 * can be reviewed before its month starts; unknown ids are ignored.
 */
export function loginArtFor(now: Date, preview?: string | null): LoginArt {
  if (preview) {
    if (preview === DEFAULT_LOGIN_ART.id) return DEFAULT_LOGIN_ART;
    const forced = LOGIN_CAMPAIGNS.find((c) => c.id === preview);
    if (forced) return forced;
  }
  const month = DateTime.fromJSDate(now, { zone: ZONE }).month;
  return LOGIN_CAMPAIGNS.find((c) => c.month === month) ?? DEFAULT_LOGIN_ART;
}
