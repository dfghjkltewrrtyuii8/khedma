import Link from "next/link";
import { redirect } from "next/navigation";
import { getLocale, getUser } from "../../lib/session";
import { t, loc, fmtSAR } from "../../lib/i18n";
import { db, findProject, proposalsFor } from "../../lib/db";

export default async function DashboardPage() {
  const locale = await getLocale();
  const user = await getUser();
  if (!user) redirect("/login");

  if (user.role === "client") {
    const mine = db().projects.filter((p) => p.clientId === user.id).sort((a, b) => b.createdAt - a.createdAt);
    return (
      <>
        <div className="row spread" style={{ marginBottom: 20 }}>
          <h2>{t(locale, "myProjects")}</h2>
          <Link href="/post" className="btn btn-small">{t(locale, "postProject")}</Link>
        </div>
        {mine.length === 0 && <p className="muted">{t(locale, "noProjects")}</p>}
        <div className="stack" style={{ gap: 12 }}>
          {mine.map((p) => (
            <Link key={p.id} href={`/projects/${p.id}`} className="glass card row spread">
              <div>
                <h3>{loc(locale, p, "title")}</h3>
                <span className="muted small">
                  {proposalsFor(p.id).length} {t(locale, "proposal")} · {fmtSAR(locale, p.budget)}
                </span>
              </div>
              <span className={`badge badge-${p.status}`}>{t(locale, "status_" + p.status)}</span>
            </Link>
          ))}
        </div>
      </>
    );
  }

  const mine = db().proposals.filter((pr) => pr.freelancerId === user.id).sort((a, b) => b.createdAt - a.createdAt);
  return (
    <>
      <h2 style={{ marginBottom: 20 }}>{t(locale, "myProposals")}</h2>
      {mine.length === 0 && <p className="muted">{t(locale, "noProposals")}</p>}
      <div className="stack" style={{ gap: 12 }}>
        {mine.map((pr) => {
          const p = findProject(pr.projectId);
          if (!p) return null;
          return (
            <Link key={pr.id} href={`/projects/${p.id}`} className="glass card row spread">
              <div>
                <h3>{loc(locale, p, "title")}</h3>
                <span className="muted small">{fmtSAR(locale, pr.amount)} · {pr.days} {t(locale, "day")}</span>
              </div>
              <span className={`badge badge-${pr.status}`}>{t(locale, pr.status)}</span>
            </Link>
          );
        })}
      </div>
    </>
  );
}
