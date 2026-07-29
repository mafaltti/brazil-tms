"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { normalizeForSearch, type SearchMode } from "@/lib/search-normalize";

/**
 * A searchable single-select over a bounded, pre-loaded option list (018, issue #25) — the shared
 * replacement for the plain resource dropdowns. Hand-rolled ARIA combobox over the existing `Input`
 * (no cmdk/popover dependency — plan R1):
 *
 * - Typing filters by CONTAINS with `normalizeForSearch` (case/accent-insensitive; `mode="plate"`
 *   also ignores hyphens/spaces) — FR-001/FR-002.
 * - When the text matches exactly ONE option's FULL label, that option is selected automatically —
 *   the paste-to-select flow (FR-003).
 * - Empty result → `emptyText` ("Nenhum resultado") — FR-004. Opening with no text shows all.
 * - Full keyboard flow: ↑/↓ move, Enter picks (a single filtered option needs no arrows), Esc
 *   closes — FR-005. Option clicks use mousedown-preventDefault so input blur can't eat them.
 * - `clearable` pins an explicit clear item (e.g. "Sem reboque" / "Todos") above the list,
 *   reachable regardless of the search text — FR-006.
 *
 * The bound `value` is always an option id (or "" — cleared); free text never becomes a value
 * (FR-007). Consumers keep their own `<Label htmlFor={id}>` wiring.
 */
export interface SearchableSelectProps {
  id: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (value: string) => void;
  placeholder: string;
  emptyText: string;
  mode?: SearchMode;
  clearable?: boolean;
  clearLabel?: string;
  disabled?: boolean;
}

const CLEAR = "__clear__";

export function SearchableSelect({
  id,
  value,
  options,
  onChange,
  placeholder,
  emptyText,
  mode = "text",
  clearable,
  clearLabel,
  disabled,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => options.find((o) => o.id === value) ?? null, [options, value]);

  const filtered = useMemo(() => {
    const q = normalizeForSearch(query, mode);
    if (!q) return options;
    return options.filter((o) => normalizeForSearch(o.label, mode).includes(q));
  }, [options, query, mode]);

  // The rendered rows: the pinned clear item (when clearable) + the filtered options (FR-006).
  const rows = useMemo(
    () =>
      clearable && clearLabel
        ? [{ id: CLEAR, label: clearLabel }, ...filtered]
        : (filtered as { id: string; label: string }[]),
    [clearable, clearLabel, filtered],
  );

  // Paste-to-select (FR-003): non-empty text matching exactly ONE option's full label picks it.
  useEffect(() => {
    if (!open) return;
    const q = normalizeForSearch(query, mode);
    if (!q) return;
    const exact = options.filter((o) => normalizeForSearch(o.label, mode) === q);
    if (exact.length === 1 && exact[0]!.id !== value) {
      onChange(exact[0]!.id);
      setOpen(false);
      setQuery("");
      inputRef.current?.blur();
    }
  }, [query, open, mode, options, value, onChange]);

  // Keep the active row in range as the filter narrows.
  useEffect(() => {
    if (activeIndex >= rows.length) setActiveIndex(0);
  }, [rows.length, activeIndex]);

  function openList() {
    if (disabled) return;
    setQuery("");
    setActiveIndex(0);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setQuery("");
  }

  function pick(rowId: string) {
    onChange(rowId === CLEAR ? "" : rowId);
    close();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      e.preventDefault();
      openList();
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // A single filtered option needs no arrowing; otherwise pick the active row.
      const target = filtered.length === 1 && query ? filtered[0] : rows[activeIndex];
      if (target) pick(target.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  const listboxId = `${id}-listbox`;

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={open && rows[activeIndex] ? `${id}-opt-${activeIndex}` : undefined}
        autoComplete="off"
        disabled={disabled}
        placeholder={selected ? selected.label : placeholder}
        value={open ? query : (selected?.label ?? "")}
        onFocus={openList}
        onClick={openList}
        onChange={(e) => {
          if (!open) setOpen(true);
          setQuery(e.target.value);
          setActiveIndex(0);
        }}
        onBlur={close}
        onKeyDown={onKeyDown}
        className="pr-8"
      />
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50"
      />
      {open ? (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={placeholder}
          className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {rows.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-muted-foreground" role="presentation">
              {emptyText}
            </li>
          ) : (
            rows.map((row, index) => (
              <li
                key={row.id}
                id={`${id}-opt-${index}`}
                role="option"
                aria-selected={row.id === value || (row.id === CLEAR && !value)}
                className={`cursor-pointer rounded-sm px-2 py-1.5 text-sm ${
                  index === activeIndex ? "bg-accent text-accent-foreground" : ""
                } ${row.id === CLEAR ? "text-muted-foreground" : ""}`}
                // preventDefault on mousedown so the input's blur doesn't close the list pre-click.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(row.id)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                {row.label}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
