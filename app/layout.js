import "./globals.css";
import Link from "next/link";
import { getLocale, getUser } from "../lib/session";
import { t, loc } from "../lib/i18n";
import { toggleLocale, logout } from "./actions";
import TabBar from "../components/TabBar";

export const metadata = {
  title: "Khedma | خدمة",
  description: "Saudi freelance marketplace",
  appleWebApp: { capable: true, title: "Khedma", statusBarStyle: "default" },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#eef2fb",
};

const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  browse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  post: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/></svg>',
  profile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  login: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/></svg>',
};

export default async function RootLayout({ children }) {
  const locale = await getLocale();
  const user = await getUser();
  const dir = locale === "ar" ? "rtl" : "ltr";

  const tabs = [
    { href: "/", label: t(locale, "home"), icon: ICONS.home },
    { href: "/projects", label: t(locale, "tabBrowse"), icon: ICONS.browse },
  ];
  if (user?.role === "client") tabs.push({ href: "/post", label: t(locale, "tabPost"), icon: ICONS.post });
  if (user) tabs.push({ href: "/dashboard", label: t(locale, "dashboard"), icon: ICONS.dashboard });
  if (user?.role === "freelancer") tabs.push({ href: "/profile", label: t(locale, "profile"), icon: ICONS.profile });
  if (!user) tabs.push({ href: "/login", label: t(locale, "signIn"), icon: ICONS.login });

  return (
    <html lang={locale} dir={dir}>
      <body>
        <div className="bg-blobs" aria-hidden="true">
          <div className="blob b1" />
          <div className="blob b2" />
          <div className="blob b3" />
        </div>
        <div className="nav-wrap">
          <nav className="nav">
            <Link href="/" className="brand">{t(locale, "appName")}</Link>
            <div className="nav-links">
              <Link className="nav-link" href="/projects">{t(locale, "browseProjects")}</Link>
              {user?.role === "client" && <Link className="nav-link" href="/post">{t(locale, "postProject")}</Link>}
              {user && <Link className="nav-link" href="/dashboard">{t(locale, "dashboard")}</Link>}
              {user?.role === "freelancer" && <Link className="nav-link" href="/profile">{t(locale, "profile")}</Link>}
            </div>
            <form action={toggleLocale}>
              <button className="chip lang-chip" type="submit" aria-label="Switch language">{t(locale, "langToggle")}</button>
            </form>
            {user ? (
              <>
                <span className="nav-user">
                  {loc(locale, user, "name")} · {t(locale, "role_" + user.role)}
                </span>
                <form action={logout}>
                  <button className="btn btn-ghost btn-small" type="submit">{t(locale, "logout")}</button>
                </form>
              </>
            ) : (
              <Link className="btn btn-small nav-login" href="/login">{t(locale, "login")}</Link>
            )}
          </nav>
        </div>
        <main className="container">{children}</main>
        <TabBar items={tabs} />
      </body>
    </html>
  );
}
