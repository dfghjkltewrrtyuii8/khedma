import Link from "next/link";
import { getLocale } from "../../lib/session";
import { t, loc, fmtSAR } from "../../lib/i18n";
import { db, CATEGORIES, findUser, proposalsFor } from "../../lib/db";

export default async function ProjectsPage({ searchParams }) {
  const locale = await getLocale();
  const sp = await searchParams;
  const cat = CATEGORIES.includes(sp?.category) ? sp.category : null;
  const projects = db()
    .projects.filter((p) => !cat || p.category === cat)
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);

  return (
    <>
      <div className="row spread" style={{ marginBottom: 20 }}>
        <h2>{t(locale, "browseProjects")}</h2>
        <Link href="/post" className="btn btn-small">{t(locale, "postProject")}</Link>
      </div>
      <div className="chips" style={{ marginBottom: 24 }}>
        <Link href="/projects" className={`chip ${!cat ? "active" : ""}`}>{t(locale, "allCategories")}</Link>
        {CATEGORIES.map((c) => (
          <Link key={c} href={`/projects?category=${c}`} className={`chip ${cat === c ? "active" : ""}`}>
            {t(locale, "cat_" + c)}
          </Link>
        ))}
      </div>
      {projects.length === 0 && <p className="muted">{t(locale, "noProjects")}</p>}
      <div className="grid">
        {projects.map((p) => {
          const client = findUser(p.clientId);
          const count = proposalsFor(p.id).length;
          return (
            <Link key={p.id} href={`/projects/${p.id}`} className="glass card project-card">
              <div className="row spread">
                <span className="badge badge-cat">{t(locale, "cat_" + p.category)}</span>
                <span className={`badge badge-${p.status}`}>{t(locale, "status_" + p.status)}</span>
              </div>
              <h3>{loc(locale, p, "title")}</h3>
              <p className="muted small clamp">{loc(locale, p, "desc")}</p>
              <div className="card-meta">
                <span className="muted">
                  {t(locale, "city_" + p.city)} · {loc(locale, client, "name")} · {count} {t(locale, "proposal")}
                </span>
                <span className="price">{fmtSAR(locale, p.budget)}</span>
              </div>
            </Link>
          );
        })}
      </div>
    </>
  );
}
