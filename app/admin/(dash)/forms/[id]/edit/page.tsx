import { notFound } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireAnalyst } from "@/lib/auth/admin";
import {
  formDefinitionSchema,
  emptyForm,
  type FormStatus,
} from "@/lib/forms/definition";
import { FormBuilder } from "./FormBuilder";
import { SystemFormView } from "./SystemFormView";

export const dynamic = "force-dynamic";

export default async function EditFormPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // El permiso de entrar lo exige esto, sin depender de que el layout gane la
  // carrera del render. El formulario se lee con la sesión: la RLS deja fuera
  // los de otra org (404).
  await requireAnalyst();
  const { id } = await params;
  const t = await getTranslations("forms");
  const supabase = await createServerSupabase();
  const { data: form } = await supabase
    .from("forms")
    .select("id, name, status, definition, system_key, system_version")
    .eq("id", id)
    .maybeSingle();
  if (!form) notFound();

  const parsed = formDefinitionSchema.safeParse(form.definition);
  const definition = parsed.success ? parsed.data : emptyForm();

  // Un formulario del sistema (0035) no pasa por el builder: se lee y se duplica.
  if (form.system_key) {
    return (
      <div>
        <div className="mx-auto max-w-5xl px-6 pt-4">
          <Link href="/admin/forms" className="text-sm text-brand hover:underline">
            ← {t("title")}
          </Link>
        </div>
        <SystemFormView
          id={form.id}
          name={form.name}
          systemKey={form.system_key as string}
          systemVersion={(form.system_version as number | null) ?? 0}
          definition={definition}
        />
      </div>
    );
  }

  return (
    <div>
      <div className="mx-auto max-w-5xl px-6 pt-4">
        <Link href="/admin/forms" className="text-sm text-brand hover:underline">
          ← {t("title")}
        </Link>
      </div>
      <FormBuilder
        id={form.id}
        initialName={form.name}
        initialStatus={form.status as FormStatus}
        initialDef={definition}
      />
    </div>
  );
}
