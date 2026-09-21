import { getLocale } from "../../lib/session";
import { t } from "../../lib/i18n";
import { login } from "../actions";

export default async function LoginPage({ searchParams }) {
  const locale = await getLocale();
  const sp = await searchParams;

  return (
    <div className="glass card" style={{ maxWidth: 440, margin: "40px auto", padding: 32 }}>
      <h2 style={{ marginBottom: 6 }}>{t(locale, "login")}</h2>
      <p className="muted small" style={{ marginBottom: 20 }}>{t(locale, "demoHint")}</p>
      {sp?.error && <div className="alert alert-error">{t(locale, "invalidLogin")}</div>}
      <form action={login}>
        <label className="field">
          <span>{t(locale, "email")}</span>
          <input className="input" name="email" type="email" required dir="ltr" placeholder="client@demo.sa" />
        </label>
        <label className="field">
          <span>{t(locale, "password")}</span>
          <input className="input" name="password" type="password" required dir="ltr" placeholder="demo1234" />
        </label>
        <button className="btn" type="submit" style={{ width: "100%" }}>{t(locale, "signIn")}</button>
      </form>
      <hr className="divider" />
      <div className="stack" style={{ gap: 10 }}>
        <form action={login}>
          <input type="hidden" name="email" value="client@demo.sa" />
          <input type="hidden" name="password" value="demo1234" />
          <button className="btn btn-ghost" type="submit" style={{ width: "100%" }}>{t(locale, "loginAsClient")}</button>
        </form>
        <form action={login}>
          <input type="hidden" name="email" value="freelancer@demo.sa" />
          <input type="hidden" name="password" value="demo1234" />
          <button className="btn btn-ghost" type="submit" style={{ width: "100%" }}>{t(locale, "loginAsFreelancer")}</button>
        </form>
      </div>
    </div>
  );
}
