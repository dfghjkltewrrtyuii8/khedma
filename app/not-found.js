import Link from "next/link";
import { getLocale } from "../lib/session";
import { t } from "../lib/i18n";

export default async function NotFound() {
  const locale = await getLocale();
  return (
    <div className="glass card" style={{ textAlign: "center", padding: 50, maxWidth: 440, margin: "60px auto" }}>
      <h2 style={{ marginBottom: 8 }}>404</h2>
      <p className="muted" style={{ marginBottom: 16 }}>{t(locale, "notFound")}</p>
      <Link href="/" className="btn btn-small">{t(locale, "home")}</Link>
    </div>
  );
}
