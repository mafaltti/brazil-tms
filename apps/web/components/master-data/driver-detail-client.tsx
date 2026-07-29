"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { CreateDriverInput } from "@brazil-tms/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DriverForm } from "@/components/master-data/driver-form";
import { ResourceDocumentsTab } from "@/components/master-data/resource-documents-tab";
import {
  archiveEntity,
  createEntity,
  MasterDataError,
  updateEntity,
  useEntityDetail,
} from "@/lib/master-data/client";
import type { DriverDto } from "@/lib/master-data/drivers-service";

interface Props {
  driverId: string;
  canArchive: boolean;
}

/** Driver create (id="new") or edit/archive (US3). */
export function DriverDetailClient({ driverId, canArchive }: Props) {
  const isNew = driverId === "new";
  const t = useTranslations("Resources.drivers");
  const tResources = useTranslations("Resources");
  const tMaster = useTranslations("MasterData");
  const tCommon = useTranslations("Common");
  const tDocs = useTranslations("Resources.documents");
  const router = useRouter();
  const queryClient = useQueryClient();

  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const detail = useEntityDetail<DriverDto>("drivers", isNew ? "" : driverId);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["master-data", "drivers"] });
  }
  function mapError(code: string | undefined): string {
    if (code === "OWNERSHIP_CARRIER_MISMATCH") return tResources("ownershipCarrierMismatch");
    return tMaster("saveError");
  }

  const saveMutation = useMutation({
    mutationFn: (values: CreateDriverInput) =>
      isNew ? createEntity("drivers", values) : updateEntity("drivers", driverId, values),
    onSuccess: () => {
      invalidate();
      router.push("/resources/drivers");
    },
    onError: (e: Error) => setError(mapError(e instanceof MasterDataError ? e.code : undefined)),
  });

  const archiveMutation = useMutation({
    mutationFn: () => archiveEntity("drivers", driverId),
    onSuccess: () => {
      setFeedback(t("archivedMsg"));
      invalidate();
    },
    onError: (e: Error) => setError(mapError(e instanceof MasterDataError ? e.code : undefined)),
  });

  const backLink = (
    <Button asChild variant="outline">
      <Link href="/resources/drivers">{tCommon("back")}</Link>
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
  const defaultValues: Partial<CreateDriverInput> | undefined = current
    ? {
        name: current.name,
        phone: current.phone ?? "",
        cpf: current.cpf ?? "",
        licenseNumber: current.licenseNumber ?? "",
        licenseCategory: current.licenseCategory ?? "",
        licenseExpiry: current.licenseExpiry ?? "",
        ownershipType: current.ownershipType,
        carrierId: current.carrierId ?? "",
        employer: current.employer ?? "",
        status: current.status,
        notes: current.notes ?? "",
      }
    : undefined;

  const formCard = (
    <Card>
      <CardHeader>
        <CardTitle>{isNew ? t("new") : (current?.name ?? "")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <DriverForm
          defaultValues={defaultValues}
          submitting={saveMutation.isPending}
          errorMessage={error}
          submitLabel={tCommon("save")}
          onCancel={() => router.push("/resources/drivers")}
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
  );

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

      {isNew ? (
        formCard
      ) : (
        /* Slice 025 (issue #32): the edit page gains the "Documentos" tab; create has no record
           to attach to yet, so it keeps the plain form. */
        <Tabs defaultValue="data">
          <TabsList>
            <TabsTrigger value="data">{tDocs("dataTab")}</TabsTrigger>
            <TabsTrigger value="documents">{tDocs("tabTitle")}</TabsTrigger>
          </TabsList>
          <TabsContent value="data">{formCard}</TabsContent>
          <TabsContent value="documents">
            <Card>
              <CardContent className="pt-6">
                <ResourceDocumentsTab entityType="driver" entityId={driverId} />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
