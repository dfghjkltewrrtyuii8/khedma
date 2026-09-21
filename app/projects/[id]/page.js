import Link from "next/link";
import { getLocale, getUser } from "../../../lib/session";
import { t, loc, fmtSAR } from "../../../lib/i18n";
import { findProject, findUser, proposalsFor } from "../../../lib/db";
import { submitProposal, acceptProposal, completeProject } from "../../actions";

export default async function ProjectPage({ params }) {
  const { id } = await params;
  const locale = await getLocale();
  const user = await getUser();
  const project = findProject(id);

  if (!project) {
    return (
      <div className="glass card" style={{ textAlign: "center", padding: 50 }}>
        <p className="muted">{t(locale, "notFound")}</p>
        <Link href="/projects" className="btn btn-ghost btn-small" style={{ marginTop: 12 }}>{t(locale, "backToProjects")}</Link>
      </div>
    );
  }

  const client = findUser(project.clientId);
  const proposals = proposalsFor(project.id).slice().sort((a, b) => b.createdAt - a.createdAt);
  const isOwner = user?.id === project.clientId;
  const myProposal = user?.role === "freelancer" ? proposals.find((pr) => pr.freelancerId === user.id) : null;
  const canPropose = user?.role === "freelancer" && project.status === "open" && !myProposal;
  const visibleProposals = isOwner ? proposals : myProposal ? [myProposal] : [];

  return (
    <div className="stack">
      <Link href="/projects" className="muted small">← {t(locale, "backToProjects")}</Link>

      <div className="glass card" style={{ padding: 30 }}>
        <div className="row spread" style={{ marginBottom: 12 }}>
          <div className="row">
            <span className="badge badge-cat">{t(locale, "cat_" + project.category)}</span>
            <span className={`badge badge-${project.status}`}>{t(locale, "status_" + project.status)}</span>
          </div>
          <span className="price" style={{ fontSize: 22 }}>{fmtSAR(locale, project.budget)}</span>
        </div>
        <h1 style={{ fontSize: 30, marginBottom: 10 }}>{loc(locale, project, "title")}</h1>
        <p className="muted small" style={{ marginBottom: 16 }}>
          {t(locale, "city_" + project.city)} · {t(locale, "postedBy")} {loc(locale, client, "name")}
        </p>
        <p style={{ lineHeight: 1.7 }}>{loc(locale, project, "desc")}</p>
        {isOwner && project.status === "in_progress" && (
          <form action={completeProject} style={{ marginTop: 20 }}>
            <input type="hidden" name="projectId" value={project.id} />
            <button className="btn" type="submit">{t(locale, "markComplete")}</button>
          </form>
        )}
        {project.status === "completed" && (
          <div className="alert alert-ok" style={{ marginTop: 20, marginBottom: 0 }}>✓ {t(locale, "completedMsg")}</div>
        )}
      </div>

      {canPropose && (
        <div className="glass card" style={{ padding: 30 }}>
          <h2 style={{ marginBottom: 16 }}>{t(locale, "submitProposal")}</h2>
          <form action={submitProposal}>
            <input type="hidden" name="projectId" value={project.id} />
            <label className="field">
              <span>{t(locale, "coverLetter")}</span>
              <textarea className="input" name="cover" required />
            </label>
            <div className="row" style={{ gap: 16 }}>
              <label className="field">
                <span>{t(locale, "amount")}</span>
                <input className="input" name="amount" type="number" min="1" required />
              </label>
              <label className="field">
                <span>{t(locale, "days")}</span>
                <input className="input" name="days" type="number" min="1" required />
              </label>
            </div>
            <button className="btn" type="submit">{t(locale, "send")}</button>
          </form>
        </div>
      )}

      {!user && project.status === "open" && (
        <div className="glass card row spread">
          <span className="muted">{t(locale, "loginToPropose")}</span>
          <Link href="/login" className="btn btn-small">{t(locale, "login")}</Link>
        </div>
      )}

      {(isOwner || myProposal) && (
        <div className="stack" style={{ gap: 12 }}>
          <h2>{isOwner ? `${t(locale, "proposals")} (${proposals.length})` : t(locale, "yourProposal")}</h2>
          {isOwner && proposals.length === 0 && <p className="muted">{t(locale, "noProposals")}</p>}
          {visibleProposals.map((pr) => {
            const f = findUser(pr.freelancerId);
            return (
              <div key={pr.id} className="glass card">
                <div className="row spread">
                  <div className="row">
                    <div className="avatar">{loc(locale, f, "name").charAt(0)}</div>
                    <div>
                      <h3>{loc(locale, f, "name")}</h3>
                      <span className="muted small">
                        {f.skills.join(" · ")}{f.hourlyRate ? ` — ${fmtSAR(locale, f.hourlyRate)}/${t(locale, "perHour")}` : ""}
                      </span>
                    </div>
                  </div>
                  <span className={`badge badge-${pr.status}`}>{t(locale, pr.status)}</span>
                </div>
                <p style={{ margin: "14px 0", lineHeight: 1.6 }}>{pr.cover}</p>
                <div className="row spread">
                  <span className="muted small">
                    <b className="price">{fmtSAR(locale, pr.amount)}</b> · {pr.days} {t(locale, "day")}
                  </span>
                  {isOwner && project.status === "open" && (
                    <form action={acceptProposal}>
                      <input type="hidden" name="proposalId" value={pr.id} />
                      <button className="btn btn-small" type="submit">{t(locale, "accept")}</button>
                    </form>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
