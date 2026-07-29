"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { CreateLocationInput } from "@brazil-tms/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LocationForm } from "@/components/master-data/location-form";
import {
  archiveEntity,
  createEntity,
  MasterDataError,
  updateEntity,
  useEntityDetail,
} from "@/lib/master-data/client";
import type { LocationDto } from "@/lib/master-data/locations-service";

interface Props {
  locationId: string;
  canArchive: boolean;
}

/** Location create (id="new") or edit/archive (US2). */
export function LocationDetailClient({ locationId, canArchive }: Props) {
  const isNew = locationId === "new";
  const t = useTranslations("MasterData.locations");
  const tMaster = useTranslations("MasterData");
  const tCommon = useTranslations("Common");
  const router = useRouter();
  const queryClient = useQueryClient();

  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const detail = useEntityDetail<LocationDto>("locations", isNew ? "" : locationId);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["master-data", "locations"] });
  }
  function mapError(code: string | undefined): string {
    if (code === "DUPLICATE_LOCATION_CODE") return t("duplicateCode");
    return tMaster("saveError");
  }

  const saveMutation = useMutation({
    mutationFn: (values: CreateLocationInput) =>
      isNew ? createEntity("locations", values) : updateEntity("locations", locationId, values),
    onSuccess: () => {
      invalidate();
      router.push("/admin/locations");
    },
    onError: (e: Error) => setError(mapError(e instanceof MasterDataError ? e.code : undefined)),
  });

  const archiveMutation = useMutation({
    mutationFn: () => archiveEntity("locations", locationId),
    onSuccess: () => {
      setFeedback(t("archivedMsg"));
      invalidate();
    },
    onError: (e: Error) => setError(mapError(e instanceof MasterDataError ? e.code : undefined)),
  });

  const backLink = (
    <Button asChild variant="outline">
      <Link href="/admin/locations">{tCommon("back")}</Link>
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
  const defaultValues: Partial<CreateLocationInput> | undefined = current
    ? {
        customerId: current.customerId,
        code: current.code,
        name: current.name,
        address: current.address ?? "",
        city: current.city ?? "",
        state: (current.state as CreateLocationInput["state"]) ?? undefined,
        country: current.country,
        latitude: current.latitude ?? undefined,
        longitude: current.longitude ?? undefined,
        gateInstructions: current.gateInstructions ?? "",
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
          <LocationForm
            defaultValues={defaultValues}
            submitting={saveMutation.isPending}
            errorMessage={error}
            submitLabel={tCommon("save")}
            onCancel={() => router.push("/admin/locations")}
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
