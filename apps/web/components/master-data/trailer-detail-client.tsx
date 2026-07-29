"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { CreateTrailerInput } from "@brazil-tms/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrailerForm } from "@/components/master-data/trailer-form";
import {
  archiveEntity,
  createEntity,
  MasterDataError,
  updateEntity,
  useEntityDetail,
} from "@/lib/master-data/client";
import type { TrailerDto } from "@/lib/master-data/trailers-service";

interface Props {
  trailerId: string;
  canArchive: boolean;
}

/** Trailer create (id="new") or edit/archive (US3). */
export function TrailerDetailClient({ trailerId, canArchive }: Props) {
  const isNew = trailerId === "new";
  const t = useTranslations("Resources.trailers");
  const tResources = useTranslations("Resources");
  const tMaster = useTranslations("MasterData");
  const tCommon = useTranslations("Common");
  const router = useRouter();
  const queryClient = useQueryClient();

  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const detail = useEntityDetail<TrailerDto>("trailers", isNew ? "" : trailerId);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["master-data", "trailers"] });
  }
  function mapError(code: string | undefined): string {
    if (code === "DUPLICATE_PLATE") return tResources("duplicatePlate");
    if (code === "OWNERSHIP_CARRIER_MISMATCH") return tResources("ownershipCarrierMismatch");
    return tMaster("saveError");
  }

  const saveMutation = useMutation({
    mutationFn: (values: CreateTrailerInput) =>
      isNew ? createEntity("trailers", values) : updateEntity("trailers", trailerId, values),
    onSuccess: () => {
      invalidate();
      router.push("/resources/trailers");
    },
    onError: (e: Error) => setError(mapError(e instanceof MasterDataError ? e.code : undefined)),
  });

  const archiveMutation = useMutation({
    mutationFn: () => archiveEntity("trailers", trailerId),
    onSuccess: () => {
      setFeedback(t("archivedMsg"));
      invalidate();
    },
    onError: (e: Error) => setError(mapError(e instanceof MasterDataError ? e.code : undefined)),
  });

  const backLink = (
    <Button asChild variant="outline">
      <Link href="/resources/trailers">{tCommon("back")}</Link>
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
  const defaultValues: Partial<CreateTrailerInput> | undefined = current
    ? {
        plate: current.plate,
        trailerType: current.trailerType,
        capacityKg: current.capacityKg ?? undefined,
        ownershipType: current.ownershipType,
        carrierId: current.carrierId ?? "",
        owner: current.owner ?? "",
        documentExpiry: current.documentExpiry ?? "",
        status: current.status,
        notes: current.notes ?? "",
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
          <CardTitle>{isNew ? t("new") : (current?.plate ?? "")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <TrailerForm
            defaultValues={defaultValues}
            submitting={saveMutation.isPending}
            errorMessage={error}
            submitLabel={tCommon("save")}
            onCancel={() => router.push("/resources/trailers")}
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
