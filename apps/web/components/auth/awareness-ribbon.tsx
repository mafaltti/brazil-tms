import { useId } from "react";

/**
 * Awareness ribbon (Outubro Rosa loop). Pure SVG so it stays crisp at any size and needs no asset.
 * The back tail is drawn first in a deeper tone, then the loop, then the front tail on top.
 */
export function AwarenessRibbon({ className }: { className?: string }) {
  const id = useId();
  const front = `${id}-front`;
  const back = `${id}-back`;

  return (
    <svg viewBox="0 0 60 100" className={className} aria-hidden focusable="false">
      <defs>
        <linearGradient id={front} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#F9A8C6" />
          <stop offset="55%" stopColor="#EC6A9C" />
          <stop offset="100%" stopColor="#D23F7C" />
        </linearGradient>
        <linearGradient id={back} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#D8558A" />
          <stop offset="100%" stopColor="#B02A63" />
        </linearGradient>
      </defs>
      <path d="M38 38 L15 93" stroke={`url(#${back})`} strokeWidth="13" fill="none" />
      <path
        d="M22 41 C9 27 13 5 30 5 C47 5 51 27 38 41"
        stroke={`url(#${front})`}
        strokeWidth="12"
        strokeLinecap="round"
        fill="none"
      />
      <path d="M22 38 L45 93" stroke={`url(#${front})`} strokeWidth="13" fill="none" />
    </svg>
  );
}
