"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { CreateLaneInput } from "@brazil-tms/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LaneForm } from "@/components/master-data/lane-form";
import {
  archiveEntity,
  createEntity,
  MasterDataError,
  updateEntity,
  useEntityDetail,
} from "@/lib/master-data/client";
import type { LaneDto } from "@/lib/master-data/lanes-service";

interface Props {
  laneId: string;
  canArchive: boolean;
}

/** Lane create (id="new") or edit/archive (US2). */
export function LaneDetailClient({ laneId, canArchive }: Props) {
  const isNew = laneId === "new";
  const t = useTranslations("MasterData.lanes");
  const tMaster = useTranslations("MasterData");
  const tCommon = useTranslations("Common");
  const router = useRouter();
  const queryClient = useQueryClient();

  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const detail = useEntityDetail<LaneDto>("lanes", isNew ? "" : laneId);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["master-data", "lanes"] });
  }
  function mapError(code: string | undefined): string {
    if (code === "INVALID_LANE_REFERENCE") return t("invalidReference");
    return tMaster("saveError");
  }

  const saveMutation = useMutation({
    mutationFn: (values: CreateLaneInput) =>
      isNew ? createEntity("lanes", values) : updateEntity("lanes", laneId, values),
    onSuccess: () => {
      invalidate();
      router.push("/admin/lanes");
    },
    onError: (e: Error) => setError(mapError(e instanceof MasterDataError ? e.code : undefined)),
  });

  const archiveMutation = useMutation({
    mutationFn: () => archiveEntity("lanes", laneId),
    onSuccess: () => {
      setFeedback(t("archivedMsg"));
      invalidate();
    },
    onError: (e: Error) => setError(mapError(e instanceof MasterDataError ? e.code : undefined)),
  });

  const backLink = (
    <Button asChild variant="outline">
      <Link href="/admin/lanes">{tCommon("back")}</Link>
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
  const defaultValues: Partial<CreateLaneInput> | undefined = current
    ? {
        customerId: current.customerId,
        originLocationId: current.originLocationId,
        destinationLocationId: current.destinationLocationId,
        expectedTransitMinutes: current.expectedTransitMinutes ?? undefined,
        defaultVehicleType:
          (current.defaultVehicleType as CreateLaneInput["defaultVehicleType"]) ?? undefined,
        standardRateCents: current.standardRateCents ?? undefined,
        tollEstimateCents: current.tollEstimateCents ?? undefined,
        standardDistanceKm: current.standardDistanceKm ?? undefined,
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
          <CardTitle>{isNew ? t("new") : t("edit")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <LaneForm
            defaultValues={defaultValues}
            submitting={saveMutation.isPending}
            errorMessage={error}
            submitLabel={tCommon("save")}
            onCancel={() => router.push("/admin/lanes")}
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
