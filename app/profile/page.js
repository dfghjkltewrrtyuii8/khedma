import { redirect } from "next/navigation";
import { getLocale, getUser } from "../../lib/session";
import { t, loc, fmtSAR } from "../../lib/i18n";
import { updateProfile } from "../actions";

export default async function ProfilePage({ searchParams }) {
  const locale = await getLocale();
  const user = await getUser();
  const sp = await searchParams;
  if (!user) redirect("/login");
  if (user.role !== "freelancer") {
    return (
      <div className="glass card" style={{ maxWidth: 560, margin: "40px auto", textAlign: "center" }}>
        <p className="muted">{t(locale, "freelancersOnly")}</p>
      </div>
    );
  }

  return (
    <div className="glass card" style={{ maxWidth: 620, margin: "20px auto", padding: 32 }}>
      <div className="row" style={{ marginBottom: 20 }}>
        <div className="avatar" style={{ width: 56, height: 56, fontSize: 22 }}>{loc(locale, user, "name").charAt(0)}</div>
        <div>
          <h2>{loc(locale, user, "name")}</h2>
          <span className="muted small">{user.hourlyRate ? `${fmtSAR(locale, user.hourlyRate)}/${t(locale, "perHour")}` : ""}</span>
        </div>
      </div>
      {sp?.saved && <div className="alert alert-ok">✓ {t(locale, "saved")}</div>}
      <form action={updateProfile}>
        <div className="row" style={{ gap: 16 }}>
          <label className="field">
            <span>{t(locale, "name")} (EN)</span>
            <input className="input" name="name" defaultValue={user.name} dir="ltr" />
          </label>
          <label className="field">
            <span>{t(locale, "name")} (ع)</span>
            <input className="input" name="nameAr" defaultValue={user.nameAr} dir="rtl" />
          </label>
        </div>
        <label className="field">
          <span>{t(locale, "hourlyRate")} ({t(locale, "sar")})</span>
          <input className="input" name="hourlyRate" type="number" min="1" defaultValue={user.hourlyRate || ""} />
        </label>
        <label className="field">
          <span>{t(locale, "skills")}</span>
          <input className="input" name="skills" defaultValue={user.skills.join(", ")} placeholder={t(locale, "skillsHint")} />
        </label>
        <label className="field">
          <span>{t(locale, "bio")}</span>
          <textarea className="input" name="bio" defaultValue={user.bio || ""} />
        </label>
        <button className="btn" type="submit">{t(locale, "save")}</button>
      </form>
    </div>
  );
}
