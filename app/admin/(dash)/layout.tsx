import { cookies } from "next/headers";
import { requireAnalyst } from "@/lib/auth/admin";
import { Sidebar } from "@/components/admin/Sidebar";
import { SIDEBAR_COOKIE } from "@/components/admin/sidebarState";
import pkg from "@/package.json";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const analyst = await requireAnalyst();
  // Leído en el server para que el primer render ya salga plegado o no: con
  // localStorage el sidebar parpadearía abierto en cada carga.
  const collapsed = (await cookies()).get(SIDEBAR_COOKIE)?.value === "collapsed";

  return (
    // `data-print-shell`: en impresión este flex se aplana a bloque, si no
    // Chrome ignora los break-inside del informe (ver globals.css).
    <div data-print-shell className="flex min-h-screen flex-col md:flex-row">
      <Sidebar
        user={{
          email: analyst.email,
          fullName: analyst.fullName,
          orgName: analyst.orgName,
          isAdmin: analyst.role === "admin",
        }}
        initialCollapsed={collapsed}
        // Marcador de build: confirma de un vistazo QUÉ está sirviendo
        // producción. La versión es la de package.json (se sube a mano en
        // cada entrega); el commit lo inyecta Vercel (`autoExposeSystemEnvs`),
        // así que ese no depende de acordarse de nada.
        build={{
          version: pkg.version,
          commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
        }}
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
