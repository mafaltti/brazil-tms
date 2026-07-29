"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { CreateCustomerInput } from "@brazil-tms/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CustomerForm } from "@/components/master-data/customer-form";
import {
  archiveEntity,
  createEntity,
  MasterDataError,
  updateEntity,
  useEntityDetail,
} from "@/lib/master-data/client";
import type { CustomerDto } from "@/lib/master-data/customers-service";

interface Props {
  customerId: string;
  canArchive: boolean;
}

/** Customer create (id="new") or edit/archive (US1). */
export function CustomerDetailClient({ customerId, canArchive }: Props) {
  const isNew = customerId === "new";
  const t = useTranslations("MasterData.customers");
  const tMaster = useTranslations("MasterData");
  const tCommon = useTranslations("Common");
  const router = useRouter();
  const queryClient = useQueryClient();

  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const detail = useEntityDetail<CustomerDto>("customers", isNew ? "" : customerId);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["master-data", "customers"] });
  }
  function mapError(code: string | undefined): string {
    if (code === "DUPLICATE_CUSTOMER_CODE") return t("duplicateCode");
    return tMaster("saveError");
  }

  const saveMutation = useMutation({
    mutationFn: (values: CreateCustomerInput) =>
      isNew ? createEntity("customers", values) : updateEntity("customers", customerId, values),
    onSuccess: () => {
      invalidate();
      router.push("/admin/customers");
    },
    onError: (e: Error) => setError(mapError(e instanceof MasterDataError ? e.code : undefined)),
  });

  const archiveMutation = useMutation({
    mutationFn: () => archiveEntity("customers", customerId),
    onSuccess: () => {
      setFeedback(t("archivedMsg"));
      invalidate();
    },
    onError: (e: Error) => setError(mapError(e instanceof MasterDataError ? e.code : undefined)),
  });

  const backLink = (
    <Button asChild variant="outline">
      <Link href="/admin/customers">{tCommon("back")}</Link>
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
  const defaultValues: Partial<CreateCustomerInput> | undefined = current
    ? {
        name: current.name,
        legalName: current.legalName ?? "",
        customerCode: current.customerCode,
        taxId: current.taxId ?? "",
        contacts: current.contacts,
        billingContact: current.billingContact ?? undefined,
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
          <CustomerForm
            defaultValues={defaultValues}
            submitting={saveMutation.isPending}
            errorMessage={error}
            submitLabel={tCommon("save")}
            onCancel={() => router.push("/admin/customers")}
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
