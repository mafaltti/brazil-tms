"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  useCreateDocumentType,
  useDocumentTypes,
  useUpdateDocumentType,
} from "@/lib/trips/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

/**
 * Document-type master admin (008, US3). Lists the proof-document types (toggle active) and adds new
 * ones (code + pt-BR label). Writes gated `manage_commercial_data`.
 */
export function DocumentTypeAdmin() {
  const t = useTranslations("Documents.typeAdmin");
  const types = useDocumentTypes();
  const create = useCreateDocumentType();
  const update = useUpdateDocumentType();

  const [code, setCode] = useState("");
  const [labelPt, setLabelPt] = useState("");

  const rows = types.data?.items ?? [];

  const onAdd = () => {
    if (!code.trim() || !labelPt.trim()) return;
    create.mutate(
      { code: code.trim(), labelPt: labelPt.trim(), active: true },
      {
        onSuccess: () => {
          setCode("");
          setLabelPt("");
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
              <span className="font-mono text-xs text-muted-foreground">{r.code}</span>
              <span className="font-medium">{r.labelPt}</span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => update.mutate({ id: r.id, input: { active: !r.active } })}
              >
                {r.active ? "✓" : "—"} {t("active")}
              </Button>
            </li>
          ))}
        </ul>

        <div className="grid grid-cols-1 gap-3 border-t pt-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="dt-code">{t("code")}</Label>
            <Input id="dt-code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={50} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dt-label">{t("label")}</Label>
            <Input
              id="dt-label"
              value={labelPt}
              onChange={(e) => setLabelPt(e.target.value)}
              maxLength={120}
            />
          </div>
        </div>
        <Button size="sm" onClick={onAdd} disabled={!code.trim() || !labelPt.trim() || create.isPending}>
          {t("add")}
        </Button>
      </CardContent>
    </Card>
  );
}
