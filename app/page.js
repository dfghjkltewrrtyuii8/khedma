import Link from "next/link";
import { getLocale } from "../lib/session";
import { t } from "../lib/i18n";
import { db, CATEGORIES } from "../lib/db";

export default async function Home() {
  const locale = await getLocale();
  const open = db().projects.filter((p) => p.status === "open").length;
  const freelancers = db().users.filter((u) => u.role === "freelancer").length;

  return (
    <>
      <section className="glass hero">
        <h1>{t(locale, "heroTitle")}</h1>
        <p>{t(locale, "heroSub")}</p>
        <div className="row" style={{ justifyContent: "center", gap: 12 }}>
          <Link href="/projects" className="btn">{t(locale, "browseProjects")}</Link>
          <Link href="/post" className="btn btn-ghost">{t(locale, "postProject")}</Link>
        </div>
        <div className="hero-stats">
          <div className="glass stat"><b>{open}</b><span>{t(locale, "open_projects")}</span></div>
          <div className="glass stat"><b>{freelancers}</b><span>{t(locale, "freelancers")}</span></div>
          <div className="glass stat"><b>{CATEGORIES.length}</b><span>{t(locale, "allCategories")}</span></div>
        </div>
      </section>
      <div className="chips" style={{ justifyContent: "center" }}>
        {CATEGORIES.map((c) => (
          <Link key={c} href={`/projects?category=${c}`} className="chip">{t(locale, "cat_" + c)}</Link>
        ))}
      </div>
    </>
  );
}
