import Link from "next/link";
import { getLocale, getUser } from "../../lib/session";
import { t } from "../../lib/i18n";
import { CATEGORIES, CITIES } from "../../lib/db";
import { postProject } from "../actions";

export default async function PostPage() {
  const locale = await getLocale();
  const user = await getUser();

  if (!user) {
    return (
      <div className="glass card row spread" style={{ maxWidth: 560, margin: "40px auto" }}>
        <span className="muted">{t(locale, "clientsOnly")}</span>
        <Link href="/login" className="btn btn-small">{t(locale, "login")}</Link>
      </div>
    );
  }
  if (user.role !== "client") {
    return (
      <div className="glass card" style={{ maxWidth: 560, margin: "40px auto", textAlign: "center" }}>
        <p className="muted">{t(locale, "clientsOnly")}</p>
      </div>
    );
  }

  return (
    <div className="glass card" style={{ maxWidth: 620, margin: "20px auto", padding: 32 }}>
      <h2 style={{ marginBottom: 20 }}>{t(locale, "postProject")}</h2>
      <form action={postProject}>
        <label className="field">
          <span>{t(locale, "title")}</span>
          <input className="input" name="title" required maxLength={120} />
        </label>
        <label className="field">
          <span>{t(locale, "description")}</span>
          <textarea className="input" name="desc" required maxLength={2000} />
        </label>
        <div className="row" style={{ gap: 16 }}>
          <label className="field">
            <span>{t(locale, "category")}</span>
            <select className="input" name="category">
              {CATEGORIES.map((c) => <option key={c} value={c}>{t(locale, "cat_" + c)}</option>)}
            </select>
          </label>
          <label className="field">
            <span>{t(locale, "city")}</span>
            <select className="input" name="city">
              {CITIES.map((c) => <option key={c} value={c}>{t(locale, "city_" + c)}</option>)}
            </select>
          </label>
        </div>
        <label className="field">
          <span>{t(locale, "budget")} ({t(locale, "sar")})</span>
          <input className="input" name="budget" type="number" min="1" required />
        </label>
        <button className="btn" type="submit" style={{ width: "100%" }}>{t(locale, "publish")}</button>
      </form>
    </div>
  );
}
