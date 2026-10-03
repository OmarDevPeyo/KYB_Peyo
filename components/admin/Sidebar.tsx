"use client";

import { useEffect, useState, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  CalendarClock,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import { Brand } from "@/components/Brand";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { ThemeToggle } from "@/components/ThemeToggle";
import { signOutAction } from "@/app/admin/actions";
import { SIDEBAR_COOKIE } from "./sidebarState";

/** Un año: es una preferencia de la persona, no de la sesión. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const iconBtnCls =
  "inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted outline-none transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/30";

/** Quién está en sesión, para el pie del sidebar. */
export interface SidebarUser {
  email: string;
  fullName: string | null;
  orgName: string;
  /** Admin de plataforma (ve todas las orgs). */
  isAdmin: boolean;
}

/**
 * Navegación del panel.
 * - Escritorio (md+): columna fija que se pliega a un riel de íconos. El
 *   estado se guarda en una cookie que el layout lee en el server.
 * - Móvil: barra superior con menú hamburguesa que abre un panel lateral.
 */
export function Sidebar({
  user,
  initialCollapsed,
}: {
  user: SidebarUser;
  initialCollapsed: boolean;
}) {
  const t = useTranslations("nav");
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "collapsed" : "expanded"}; path=/admin; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
  }

  // Panel móvil abierto: Escape lo cierra, el fondo no scrollea, y si la
  // ventana crece a escritorio se cierra solo (si no, el body quedaría sin
  // scroll con el panel oculto por CSS).
  useEffect(() => {
    if (!mobileOpen) return;
    const close = () => setMobileOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const desktop = window.matchMedia("(min-width: 768px)");
    const onResize = () => {
      if (desktop.matches) close();
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    desktop.addEventListener("change", onResize);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
      desktop.removeEventListener("change", onResize);
    };
  }, [mobileOpen]);

  const closeMobile = () => setMobileOpen(false);

  return (
    <>
      {/* ---------- Móvil: barra superior ---------- */}
      <header
        data-no-print
        className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface/95 px-3 backdrop-blur md:hidden"
      >
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label={t("openMenu")}
          aria-expanded={mobileOpen}
          aria-controls="admin-mobile-nav"
          className={iconBtnCls}
        >
          <Menu size={20} aria-hidden />
        </button>
        <Link href="/admin" aria-label="Peyo" className="rounded-lg">
          <Brand size="sm" />
        </Link>
      </header>

      {mobileOpen && (
        <div data-no-print className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={closeMobile}
            aria-hidden
          />
          <div
            id="admin-mobile-nav"
            role="dialog"
            aria-modal="true"
            aria-label={t("main")}
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-surface shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <Link href="/admin" aria-label="Peyo" onClick={closeMobile}>
                <Brand size="md" />
              </Link>
              <button
                type="button"
                onClick={closeMobile}
                aria-label={t("closeMenu")}
                autoFocus
                className={iconBtnCls}
              >
                <X size={20} aria-hidden />
              </button>
            </div>
            <NavLinks collapsed={false} isAdmin={user.isAdmin} onNavigate={closeMobile} />
            <SidebarFooter collapsed={false} user={user} />
          </div>
        </div>
      )}

      {/* ---------- Escritorio ---------- */}
      <aside
        data-no-print
        className={`hidden border-r border-border bg-surface transition-[width] duration-200 md:sticky md:top-0 md:flex md:h-screen md:shrink-0 md:flex-col md:self-start md:overflow-x-hidden md:overflow-y-auto ${
          collapsed ? "md:w-18" : "md:w-64"
        }`}
      >
        <div
          className={`flex border-b border-border py-4 ${
            collapsed ? "flex-col items-center gap-3 px-2" : "items-center justify-between gap-2 px-4"
          }`}
        >
          <Link href="/admin" aria-label="Peyo" className="rounded-lg">
            {collapsed ? <Isotype /> : <Brand size="lg" />}
          </Link>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? t("expand") : t("collapse")}
            title={collapsed ? t("expand") : t("collapse")}
            aria-expanded={!collapsed}
            className={iconBtnCls}
          >
            {collapsed ? (
              <PanelLeftOpen size={18} aria-hidden />
            ) : (
              <PanelLeftClose size={18} aria-hidden />
            )}
          </button>
        </div>
        <NavLinks collapsed={collapsed} isAdmin={user.isAdmin} />
        <SidebarFooter collapsed={collapsed} user={user} />
      </aside>
    </>
  );
}

function NavLinks({
  collapsed,
  isAdmin,
  onNavigate,
}: {
  collapsed: boolean;
  isAdmin: boolean;
  onNavigate?: () => void;
}) {
  const t = useTranslations("nav");
  const pathname = usePathname();

  const items: { href: string; label: string; icon: ReactNode; exact: boolean }[] = [
    { href: "/admin", label: t("requests"), icon: <ListIcon />, exact: true },
    { href: "/admin/forms", label: t("forms"), icon: <TemplateIcon />, exact: false },
    {
      href: "/admin/expirations",
      label: t("expirations"),
      icon: <CalendarClock size={18} aria-hidden />,
      exact: false,
    },
    // El catálogo de DIDIT es el de la cuenta de Peyo: solo el admin (las
    // páginas lo exigen también; esto solo evita mostrar un link que da 404).
    ...(isAdmin
      ? [{ href: "/admin/didit", label: t("didit"), icon: <FormIcon />, exact: false }]
      : []),
    { href: "/admin/clients", label: t("clients"), icon: <KeyIcon />, exact: false },
    { href: "/admin/ai-usage", label: t("aiUsage"), icon: <ChartIcon />, exact: false },
    // Gestión de cuentas: solo el admin (la página exige además su 2FA para
    // modificar).
    ...(isAdmin
      ? [
          {
            href: "/admin/users",
            label: t("users"),
            icon: <Users size={18} aria-hidden />,
            exact: false,
          },
        ]
      : []),
    {
      href: "/admin/security",
      label: t("security"),
      icon: <ShieldCheck size={18} aria-hidden />,
      exact: false,
    },
  ];

  return (
    <nav aria-label={t("main")} className={`flex-1 space-y-1 ${collapsed ? "px-2 py-3" : "p-3"}`}>
      {items.map((it) => {
        const active = it.exact ? pathname === it.href : pathname.startsWith(it.href);
        return (
          <Link
            key={it.href}
            href={it.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            // Plegado solo queda el ícono: el nombre va al tooltip y al lector.
            title={collapsed ? it.label : undefined}
            aria-label={collapsed ? it.label : undefined}
            className={`flex items-center rounded-lg text-sm font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/30 ${
              collapsed ? "mx-auto h-10 w-10 justify-center" : "gap-3 px-3 py-2"
            } ${active ? "bg-brand/10 text-brand" : "text-foreground hover:bg-surface-2"}`}
          >
            <span className="shrink-0">{it.icon}</span>
            {!collapsed && <span className="truncate">{it.label}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarFooter({ collapsed, user }: { collapsed: boolean; user: SidebarUser }) {
  const tc = useTranslations("common");
  const tOrgs = useTranslations("orgs");
  const name = user.fullName?.trim() || user.email;
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  const who = `${name} · ${user.orgName}${user.isAdmin ? ` · ${tOrgs("adminRole")}` : ""}`;

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-2 border-t border-border px-2 py-3">
        <ThemeToggle />
        <LanguageSwitcher compact />
        <span
          title={who}
          className="mt-1 flex h-8 w-8 items-center justify-center rounded-full bg-brand/10 text-xs font-semibold text-brand"
        >
          {initial}
        </span>
        <form action={signOutAction}>
          <button
            aria-label={tc("logout")}
            title={tc("logout")}
            className={iconBtnCls}
          >
            <LogOut size={18} aria-hidden />
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-3 border-t border-border p-3">
      <div className="flex items-center gap-2">
        <LanguageSwitcher />
        <ThemeToggle />
      </div>
      <div className="flex min-w-0 items-center gap-2 px-1" title={`${who}\n${user.email}`}>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand/10 text-xs font-semibold text-brand">
          {initial}
        </span>
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-medium text-foreground">{name}</p>
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
            <span className="truncate">{user.orgName}</span>
            {user.isAdmin && (
              <span className="shrink-0 rounded bg-brand/10 px-1 text-[10px] font-semibold text-brand uppercase">
                {tOrgs("adminRole")}
              </span>
            )}
          </p>
        </div>
      </div>
      <form action={signOutAction}>
        <button className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground transition-colors hover:bg-surface-2">
          <LogOut size={16} aria-hidden />
          {tc("logout")}
        </button>
      </form>
    </div>
  );
}

/** Isotipo para el riel plegado; mismo chip claro que `Brand` en modo oscuro. */
function Isotype() {
  return (
    <span className="inline-flex rounded-lg p-1 dark:bg-white/90">
      <Image
        src="/peyo-isotipo.png"
        alt="Peyo"
        width={512}
        height={512}
        priority
        className="h-8 w-8"
      />
    </span>
  );
}

function ListIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

function TemplateIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function FormIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <line x1="8" y1="8" x2="16" y2="8" />
      <line x1="8" y1="12" x2="16" y2="12" />
      <line x1="8" y1="16" x2="13" y2="16" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <path d="M7 15l3-4 3 3 5-7" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M10.7 12.3 21 2" />
      <path d="M17 6l3 3" />
      <path d="M14 9l3 3" />
    </svg>
  );
}
