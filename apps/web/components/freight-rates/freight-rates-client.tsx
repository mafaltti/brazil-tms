"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowUpDown } from "lucide-react";
import { formatBRL, normalizeText, type FreightRateItem } from "@brazil-tms/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useFreightRates, type FreightRateServerFilters } from "@/lib/freight-rates/client";
import { FreightRatesUploadDialog } from "./upload-dialog";

const ALL = "__all__";
const EMPTY = "—";

/** Reais input ("1.300,50" or "1300.50") → integer centavos; undefined when blank/invalid. */
function reaisInputToCents(value: string): number | undefined {
  const text = value.trim();
  if (text === "") return undefined;
  const parsed = Number(text.replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.round(parsed * 100);
}

/**
 * 016 US1 — the "Tabela de Fretes" tab: UF selects + city inputs (datalist suggestions from the
 * dataset, accent-insensitive contains matching — research R5), Valor Ida price range, sortable
 * Valor Ida / Km headers (server sort, nulls last). UF/price/sort filter server-side; cities
 * client-side over the polled dataset.
 */
export function FreightRatesClient({ canImport }: { canImport: boolean }) {
  const t = useTranslations("FreightRates");
  const [originUf, setOriginUf] = useState(ALL);
  const [destinationUf, setDestinationUf] = useState(ALL);
  const [originCity, setOriginCity] = useState("");
  const [destinationCity, setDestinationCity] = useState("");
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [sort, setSort] = useState<"valorIda" | "km" | undefined>(undefined);

  const serverFilters = useMemo<FreightRateServerFilters>(
    () => ({
      originUf: originUf === ALL ? undefined : originUf,
      destinationUf: destinationUf === ALL ? undefined : destinationUf,
      priceMinCents: reaisInputToCents(priceMin),
      priceMaxCents: reaisInputToCents(priceMax),
      sort,
    }),
    [originUf, destinationUf, priceMin, priceMax, sort],
  );

  const query = useFreightRates(serverFilters);
  const rates = useMemo(() => query.data ?? [], [query.data]);

  const originUfOptions = useMemo(
    () => [...new Set(rates.map((r) => r.originUf))].sort(),
    [rates],
  );
  const destinationUfOptions = useMemo(
    () => [...new Set(rates.map((r) => r.destinationUf))].sort(),
    [rates],
  );
  const originCityOptions = useMemo(
    () => [...new Set(rates.map((r) => r.originCity))].sort(),
    [rates],
  );
  const destinationCityOptions = useMemo(
    () => [...new Set(rates.map((r) => r.destinationCity))].sort(),
    [rates],
  );

  const visibleRates = useMemo(() => {
    const originNeedle = normalizeText(originCity);
    const destinationNeedle = normalizeText(destinationCity);
    return rates.filter((rate) => {
      if (originNeedle !== "" && !normalizeText(rate.originCity).includes(originNeedle)) return false;
      if (destinationNeedle !== "" && !normalizeText(rate.destinationCity).includes(destinationNeedle)) {
        return false;
      }
      return true;
    });
  }, [rates, originCity, destinationCity]);

  const hasActiveFilters =
    originUf !== ALL ||
    destinationUf !== ALL ||
    originCity !== "" ||
    destinationCity !== "" ||
    priceMin !== "" ||
    priceMax !== "";

  function clearFilters() {
    setOriginUf(ALL);
    setDestinationUf(ALL);
    setOriginCity("");
    setDestinationCity("");
    setPriceMin("");
    setPriceMax("");
    setSort(undefined);
  }

  function toggleSort(column: "valorIda" | "km") {
    setSort((current) => (current === column ? undefined : column));
  }

  const isEmptyTable = !query.isPending && rates.length === 0 && !hasActiveFilters;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="freight-origin-uf">{t("filters.originUf")}</Label>
          <Select value={originUf} onValueChange={setOriginUf}>
            <SelectTrigger id="freight-origin-uf" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("filters.all")}</SelectItem>
              {originUfOptions.map((uf) => (
                <SelectItem key={uf} value={uf}>
                  {uf}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="freight-origin-city">{t("filters.originCity")}</Label>
          <Input
            id="freight-origin-city"
            list="freight-origin-cities"
            value={originCity}
            onChange={(e) => setOriginCity(e.target.value)}
            placeholder={t("filters.cityPlaceholder")}
            className="w-48"
          />
          <datalist id="freight-origin-cities">
            {originCityOptions.map((city) => (
              <option key={city} value={city} />
            ))}
          </datalist>
        </div>
        <div className="space-y-1">
          <Label htmlFor="freight-destination-uf">{t("filters.destinationUf")}</Label>
          <Select value={destinationUf} onValueChange={setDestinationUf}>
            <SelectTrigger id="freight-destination-uf" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("filters.all")}</SelectItem>
              {destinationUfOptions.map((uf) => (
                <SelectItem key={uf} value={uf}>
                  {uf}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="freight-destination-city">{t("filters.destinationCity")}</Label>
          <Input
            id="freight-destination-city"
            list="freight-destination-cities"
            value={destinationCity}
            onChange={(e) => setDestinationCity(e.target.value)}
            placeholder={t("filters.cityPlaceholder")}
            className="w-48"
          />
          <datalist id="freight-destination-cities">
            {destinationCityOptions.map((city) => (
              <option key={city} value={city} />
            ))}
          </datalist>
        </div>
        <div className="space-y-1">
          <Label htmlFor="freight-price-min">{t("filters.priceMin")}</Label>
          <Input
            id="freight-price-min"
            inputMode="decimal"
            value={priceMin}
            onChange={(e) => setPriceMin(e.target.value)}
            placeholder="0,00"
            className="w-32"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="freight-price-max">{t("filters.priceMax")}</Label>
          <Input
            id="freight-price-max"
            inputMode="decimal"
            value={priceMax}
            onChange={(e) => setPriceMax(e.target.value)}
            placeholder="0,00"
            className="w-32"
          />
        </div>
        {hasActiveFilters ? (
          <Button variant="ghost" onClick={clearFilters}>
            {t("filters.clear")}
          </Button>
        ) : null}
        <div className="ml-auto">{canImport ? <FreightRatesUploadDialog /> : null}</div>
      </div>

      {query.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : isEmptyTable ? (
        <p className="rounded-md border p-6 text-center text-muted-foreground">
          {canImport ? t("empty.noDataCanImport") : t("empty.noData")}
        </p>
      ) : visibleRates.length === 0 ? (
        <div className="space-y-2 rounded-md border p-6 text-center">
          <p className="text-muted-foreground">{t("empty.noMatches")}</p>
          <Button variant="outline" onClick={clearFilters}>
            {t("filters.clear")}
          </Button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.origin")}</TableHead>
                <TableHead>{t("columns.destination")}</TableHead>
                <TableHead>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1"
                    onClick={() => toggleSort("km")}
                    aria-pressed={sort === "km"}
                  >
                    {t("columns.km")}
                    <ArrowUpDown className="h-3.5 w-3.5" />
                  </button>
                </TableHead>
                <TableHead>{t("columns.vehicleType")}</TableHead>
                <TableHead>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1"
                    onClick={() => toggleSort("valorIda")}
                    aria-pressed={sort === "valorIda"}
                  >
                    {t("columns.valorIda")}
                    <ArrowUpDown className="h-3.5 w-3.5" />
                  </button>
                </TableHead>
                <TableHead>{t("columns.valorReversa")}</TableHead>
                <TableHead>{t("columns.observacoes")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRates.map((rate: FreightRateItem) => (
                <TableRow key={rate.id}>
                  <TableCell>
                    {rate.originCity} / {rate.originUf}
                  </TableCell>
                  <TableCell>
                    {rate.destinationCity} / {rate.destinationUf}
                  </TableCell>
                  <TableCell>{rate.km ?? EMPTY}</TableCell>
                  <TableCell>{rate.vehicleType}</TableCell>
                  <TableCell>
                    {rate.valorIdaCents === null ? EMPTY : formatBRL(rate.valorIdaCents)}
                  </TableCell>
                  <TableCell>
                    {rate.valorReversaCents === null ? EMPTY : formatBRL(rate.valorReversaCents)}
                  </TableCell>
                  <TableCell className="max-w-64 truncate" title={rate.observacoes ?? undefined}>
                    {rate.observacoes ?? EMPTY}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
