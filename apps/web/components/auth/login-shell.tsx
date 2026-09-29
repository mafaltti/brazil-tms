"use client";

import type { CSSProperties, ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Waypoints } from "lucide-react";
import { loginArtFor } from "@/lib/login-art";
import { AwarenessRibbon } from "./awareness-ribbon";

/** Ribbons sit on the frame corners, slightly tilted outward. */
const RIBBON_CORNERS = [
  "-left-1 -top-1 -rotate-[18deg]",
  "-right-1 -top-1 rotate-[18deg]",
  "-bottom-1 -left-1 -rotate-[10deg]",
  "-bottom-1 -right-1 rotate-[10deg]",
];

/**
 * Two-column login frame: brand panel with the (seasonal) art on the left, the form on the right.
 * The panel hides below `lg`. The art sits in a frame locked to its own 888:499 ratio, so it never
 * crops on any screen; a blurred copy fills the rest of the panel behind the green overlay.
 * Frame, backdrop and accents follow the art's palette; campaigns add ribbons and a note.
 */
export function LoginShell({ children }: { children: ReactNode }) {
  const t = useTranslations("Auth.panel");
  const searchParams = useSearchParams();
  const art = loginArtFor(new Date(), searchParams.get("arte"));
  const { palette } = art;
  const vars = {
    "--login-accent": palette.accent,
    "--login-frame": palette.frame,
    "--login-frame-dark": palette.frameDark,
    "--login-glow": palette.glow,
  } as CSSProperties;

  return (
    <div className={`relative w-full ${art.campaign ? "p-2" : ""}`} style={vars}>
      <div
        aria-hidden
        className="fixed inset-0 dark:hidden"
        style={{ background: palette.backdrop }}
      />
      <div
        className={`relative flex flex-col overflow-hidden rounded-[26px] border-[var(--login-frame)] bg-white p-2.5 shadow-[0_40px_90px_-45px_var(--login-glow)] dark:border-[var(--login-frame-dark)] dark:bg-card dark:shadow-[0_40px_90px_-45px_rgba(0,0,0,0.8)] ${art.campaign ? "min-h-[calc(100vh-3rem)] border-[3px] ring-4 ring-white/60 dark:ring-black/20" : "min-h-[calc(100vh-2rem)] border"}`}
      >
        <div className="grid flex-1 gap-2.5 lg:grid-cols-[minmax(0,1.02fr)_minmax(0,1fr)]">
          <div
            className="relative hidden overflow-hidden rounded-[22px] bg-[#1D2B18] lg:block"
            data-login-art={art.id}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- static art, no optimizer needed */}
            <img
              src={art.src}
              alt=""
              className="absolute inset-0 h-full w-full scale-[1.25] object-cover blur-[26px] saturate-[1.25] brightness-[1.05]"
            />
            <div className="absolute inset-0" style={{ background: palette.overlay }} />
            <div className="relative flex h-full flex-col p-4 xl:p-6">
              <div className="shrink-0 rounded-[18px] border border-white/25 bg-white/10 p-5 shadow-[0_18px_50px_-30px_rgba(0,0,0,0.9)] backdrop-blur-md xl:p-6">
                <p className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/90">
                  <span className="h-[3px] w-6 rounded-full bg-[var(--login-accent)]" />
                  {t("eyebrow")}
                </p>
                <h2 className="mt-4 text-[26px] font-bold leading-[1.1] tracking-[-0.02em] text-white xl:text-[32px]">
                  <span className="block">{t("headline1")}</span>
                  <span className="block">{t("headline2")}</span>
                  <span className="block">{t("headline3")}</span>
                </h2>
                <p className="mt-4 text-[13.5px] leading-[1.6] text-white/85 xl:text-[15px]">
                  <span className="block">{t("tagline1")}</span>
                  <span className="block">{t("tagline2")}</span>
                </p>
              </div>
              <div className="flex flex-1 items-center justify-center">
                <div className="-mx-4 aspect-[888/499] [-webkit-mask-image:linear-gradient(to_right,transparent_0%,#000_11%,#000_91%,transparent_100%)] [mask-image:linear-gradient(to_right,transparent_0%,#000_11%,#000_91%,transparent_100%)] [@media(max-height:830px)]:max-w-[78%] xl:-mx-6">
                  <div className="h-full w-full [-webkit-mask-image:linear-gradient(to_bottom,transparent_0%,#000_14%,#000_90%,transparent_100%)] [mask-image:linear-gradient(to_bottom,transparent_0%,#000_14%,#000_90%,transparent_100%)]">
                    {/* eslint-disable-next-line @next/next/no-img-element -- static art, no optimizer needed */}
                    <img
                      src={art.src}
                      alt={t(`art.${art.id}`)}
                      className="h-full w-full object-cover"
                    />
                  </div>
                </div>
              </div>
              <div className="mt-5 flex shrink-0 items-center justify-between gap-4 rounded-[18px] border border-white/25 bg-white/10 p-4 shadow-[0_18px_50px_-30px_rgba(0,0,0,0.9)] backdrop-blur-md xl:p-5">
                <div>
                  <p className="text-[14px] font-medium text-white xl:text-[15px]">{t("footer")}</p>
                  <p className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/70">
                    {t("footerCaption")}
                  </p>
                </div>
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-white/30 bg-white/10 xl:size-11">
                  <Waypoints className="size-5 text-white" aria-hidden />
                </span>
              </div>
            </div>
          </div>
          <div className="flex flex-col">
            <div className="flex flex-1">
              <div className="mx-auto flex w-full max-w-[480px] flex-col justify-center px-6 py-6 sm:px-9 lg:px-10 [@media(max-height:830px)]:py-3">
                <div className="flex items-center justify-between gap-4">
                  {/* eslint-disable-next-line @next/next/no-img-element -- static logo */}
                  <img
                    src="/marca/brazil-transports.png"
                    alt={t("logoAlt")}
                    className="h-10 w-auto dark:hidden xl:h-11"
                  />
                  {/* eslint-disable-next-line @next/next/no-img-element -- static logo */}
                  <img
                    src="/marca/brazil-transports-escuro.png"
                    alt={t("logoAlt")}
                    className="hidden h-10 w-auto dark:block xl:h-11"
                  />
                  <span className="border-l border-[#E2E6DD] pl-4 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#6B7566] dark:border-border dark:text-muted-foreground">
                    {t("productName")}
                  </span>
                </div>
                {children}
                {art.campaign ? (
                  <div className="mt-8 flex items-center gap-3.5 rounded-2xl border border-[var(--login-frame)] bg-[#FFF4F8] p-3.5 dark:border-[var(--login-frame-dark)] dark:bg-[#2A1520]">
                    <AwarenessRibbon className="h-10 w-6 shrink-0" />
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#C2185B] dark:text-[#F48FB1]">
                        {t(`campaign.${art.id}.title`)}
                      </p>
                      <p className="mt-1 text-[13px] leading-snug text-[#6B4A57] dark:text-muted-foreground">
                        {t(`campaign.${art.id}.text`)}
                      </p>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
      {art.campaign
        ? RIBBON_CORNERS.map((corner) => (
            <AwarenessRibbon
              key={corner}
              className={`pointer-events-none absolute z-10 h-[72px] w-11 drop-shadow-[0_6px_12px_rgba(176,42,99,0.4)] ${corner}`}
            />
          ))
        : null}
    </div>
  );
}
