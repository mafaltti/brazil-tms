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
  palette: LoginPalette;
  /** Campaign dressing: awareness ribbons on the frame corners + the campaign note under the form. */
  campaign: boolean;
}

/** Colors the login frame takes from the active art. Brand pieces (logo, green button) never change. */
export interface LoginPalette {
  /** Small accents: eyebrow bar and dot. */
  accent: string;
  /** Outer frame border, light and dark themes. */
  frame: string;
  frameDark: string;
  /** Drop shadow color under the frame. */
  glow: string;
  /** Page background behind the frame (light theme). */
  backdrop: string;
  /** Tint over the blurred art on the left panel. */
  overlay: string;
}

const BRAND_PALETTE: LoginPalette = {
  accent: "#D9BA05",
  frame: "rgba(0,0,0,0.06)",
  frameDark: "hsl(var(--border))",
  glow: "rgba(23,38,18,0.45)",
  backdrop:
    "radial-gradient(1100px 620px at 12% 8%, #E7EDE2 0%, rgba(231,237,226,0) 62%), radial-gradient(900px 560px at 92% 96%, #E4EAF1 0%, rgba(228,234,241,0) 58%), linear-gradient(160deg, #F4F6F1 0%, #EEF2EA 52%, #E9EEE6 100%)",
  overlay:
    "linear-gradient(180deg, rgba(62,86,53,0.77) 0%, rgba(62,86,53,0.48) 34%, rgba(62,86,53,0.27) 52%, rgba(36,51,24,0.42) 74%, rgba(29,43,24,0.85) 100%)",
};

/** Outubro Rosa: pink frame and backdrop; the panel keeps the brand green on top and warms to rose. */
const PINK_PALETTE: LoginPalette = {
  accent: "#EC6A9C",
  frame: "#EE9DBC",
  frameDark: "#8A3A5E",
  glow: "rgba(214,51,108,0.38)",
  backdrop:
    "radial-gradient(1100px 620px at 12% 8%, #FBE1EB 0%, rgba(251,225,235,0) 62%), radial-gradient(900px 560px at 92% 96%, #F8D7E4 0%, rgba(248,215,228,0) 58%), linear-gradient(160deg, #FFF6F9 0%, #FDEEF4 52%, #FAE6EE 100%)",
  overlay:
    "linear-gradient(180deg, rgba(62,86,53,0.74) 0%, rgba(62,86,53,0.42) 32%, rgba(128,58,90,0.2) 54%, rgba(118,40,78,0.44) 76%, rgba(72,22,48,0.86) 100%)",
};

export const DEFAULT_LOGIN_ART: LoginArt = {
  id: "padrao",
  src: "/marca/banco-mercedez-benz-1.avif",
  palette: BRAND_PALETTE,
  campaign: false,
};

interface Campaign extends LoginArt {
  /** Calendar month (1-12) during which the campaign art replaces the default. */
  month: number;
}

export const LOGIN_CAMPAIGNS: readonly Campaign[] = [
  // Outubro Rosa — breast cancer awareness, the whole of October.
  {
    id: "outubro-rosa",
    month: 10,
    src: "/marca/outubro-rosa.avif",
    palette: PINK_PALETTE,
    campaign: true,
  },
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
