"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { CreateCarrierInput } from "@brazil-tms/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CarrierForm } from "@/components/master-data/carrier-form";
import {
  archiveEntity,
  createEntity,
  MasterDataError,
  updateEntity,
  useEntityDetail,
} from "@/lib/master-data/client";
import type { CarrierDto } from "@/lib/master-data/carriers-service";

interface Props {
  carrierId: string;
  canArchive: boolean;
}

/** Carrier create (id="new") or edit/archive (US4). */
export function CarrierDetailClient({ carrierId, canArchive }: Props) {
  const isNew = carrierId === "new";
  const t = useTranslations("Resources.carriers");
  const tResources = useTranslations("Resources");
  const tMaster = useTranslations("MasterData");
  const tCommon = useTranslations("Common");
  const router = useRouter();
  const queryClient = useQueryClient();

  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const detail = useEntityDetail<CarrierDto>("carriers", isNew ? "" : carrierId);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["master-data", "carriers"] });
  }
  function mapError(code: string | undefined): string {
    if (code === "DUPLICATE_TAX_ID") return tResources("duplicateTaxId");
    return tMaster("saveError");
  }

  const saveMutation = useMutation({
    mutationFn: (values: CreateCarrierInput) =>
      isNew ? createEntity("carriers", values) : updateEntity("carriers", carrierId, values),
    onSuccess: () => {
      invalidate();
      router.push("/resources/carriers");
    },
    onError: (e: Error) => setError(mapError(e instanceof MasterDataError ? e.code : undefined)),
  });

  const archiveMutation = useMutation({
    mutationFn: () => archiveEntity("carriers", carrierId),
    onSuccess: () => {
      setFeedback(t("archivedMsg"));
      invalidate();
    },
    onError: (e: Error) => setError(mapError(e instanceof MasterDataError ? e.code : undefined)),
  });

  const backLink = (
    <Button asChild variant="outline">
      <Link href="/resources/carriers">{tCommon("back")}</Link>
    </Button>
  );

  if (!isNew && detail.isLoading) {
    return <p className="text-muted-foreground">{tCommon("loading")}</p>;
  }
  if (!isNew && (detail.isError || !detail.data)) {
    return (
      <div className="space-y-4">
        <p role="alert" className="text-sm text-destructive">
          {tMaster("loadError")}
        </p>
        {backLink}
      </div>
    );
  }

  const current = detail.data;
  const defaultValues: Partial<CreateCarrierInput> | undefined = current
    ? {
        name: current.name,
        legalName: current.legalName ?? "",
        taxId: current.taxId ?? "",
        contact: current.contact ?? undefined,
        contractStatus: current.contractStatus as CreateCarrierInput["contractStatus"],
        documentationStatus:
          current.documentationStatus as CreateCarrierInput["documentationStatus"],
      }
    : undefined;

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">{isNew ? t("create") : t("edit")}</h1>
        {backLink}
      </div>

      {feedback ? (
        <p role="status" className="text-sm text-muted-foreground">
          {feedback}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{isNew ? t("new") : (current?.name ?? "")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <CarrierForm
            defaultValues={defaultValues}
            submitting={saveMutation.isPending}
            errorMessage={error}
            submitLabel={tCommon("save")}
            onCancel={() => router.push("/resources/carriers")}
            onSubmit={(values) => saveMutation.mutate(values)}
          />

          {!isNew && canArchive && current && !current.archived ? (
            <div className="border-t pt-4">
              <Button
                variant="ghost"
                disabled={archiveMutation.isPending}
                onClick={() => archiveMutation.mutate()}
              >
                {tMaster("archive")}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
