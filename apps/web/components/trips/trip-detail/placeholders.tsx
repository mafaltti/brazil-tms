import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Trip Detail placeholder sections. The documents section is now the live `DocumentsSection` (008 US1);
 * the billing section is filled by 008 US2 (`BillingSection`). Presentational (no `"use client"`).
 */
function PlaceholderCard({
  titleKey,
  bodyKey,
}: {
  titleKey: "sectionBilling";
  bodyKey: "placeholderBilling";
}) {
  const t = useTranslations("Trips.detail");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(titleKey)}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{t(bodyKey)}</p>
      </CardContent>
    </Card>
  );
}

export function BillingPlaceholder() {
  return <PlaceholderCard titleKey="sectionBilling" bodyKey="placeholderBilling" />;
}
