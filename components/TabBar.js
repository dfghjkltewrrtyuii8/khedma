"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function TabBar({ items }) {
  const pathname = usePathname();
  return (
    <nav className="tabbar" aria-label="Main">
      {items.map((it) => {
        const active = it.href === "/" ? pathname === "/" : pathname.startsWith(it.href);
        return (
          <Link key={it.href} href={it.href} className={`tab ${active ? "active" : ""}`}>
            <span className="tab-icon" dangerouslySetInnerHTML={{ __html: it.icon }} />
            <span className="tab-label">{it.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
