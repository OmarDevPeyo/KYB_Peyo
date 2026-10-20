import { getLocale, getTranslations } from "next-intl/server";
import { DynamicForm } from "@/components/forms/DynamicForm";
import { resolveText, type FormDefinition } from "@/lib/forms/definition";
import { DuplicateFormButton } from "../../FormRow";

/**
 * Formulario del sistema (0035): se define en lib/forms/system/ y lo instala
 * la sincronización. El panel lo muestra solo para leer, con la vista previa
 * que ve el solicitante, y deja duplicarlo para editar una copia.
 */
export async function SystemFormView({
  id,
  name,
  systemKey,
  systemVersion,
  definition,
}: {
  id: string;
  name: string;
  systemKey: string;
  systemVersion: number;
  definition: FormDefinition;
}) {
  const t = await getTranslations("forms");
  const appLocale = await getLocale();
  const locale = definition.locales.includes(appLocale) ? appLocale : definition.defaultLocale;

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            {t("systemTitle")}
          </p>
          <h1 className="font-display text-xl font-bold text-foreground">{name}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            {t("systemNotice", { key: systemKey, version: systemVersion })}
          </p>
        </div>
        <DuplicateFormButton id={id} name={name} />
      </div>

      <div className="mx-auto max-w-2xl">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
          {t("systemPreview")}
        </p>
        <h2 className="mb-4 font-display text-2xl font-bold text-foreground">
          {resolveText(definition.title, locale)}
        </h2>
        <DynamicForm definition={definition} locale={locale} mode="preview" />
      </div>
    </div>
  );
}
