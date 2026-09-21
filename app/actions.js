"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db, newId, findProject } from "../lib/db";

const COOKIE = { httpOnly: true, sameSite: "lax", path: "/" };

export async function login(formData) {
  const email = (formData.get("email") || "").toString().trim().toLowerCase();
  const password = (formData.get("password") || "").toString();
  const user = db().users.find((u) => u.email === email && u.password === password);
  if (!user) redirect("/login?error=1");
  const c = await cookies();
  c.set("uid", user.id, COOKIE);
  redirect("/projects");
}

export async function logout() {
  const c = await cookies();
  c.delete("uid");
  redirect("/");
}

export async function toggleLocale() {
  const c = await cookies();
  const current = c.get("locale")?.value === "en" ? "en" : "ar";
  c.set("locale", current === "ar" ? "en" : "ar", { ...COOKIE, httpOnly: false });
  const referer = (await headers()).get("referer");
  let back = "/";
  try { if (referer) { const u = new URL(referer); back = u.pathname + u.search; } } catch {}
  redirect(back);
}

async function requireUser(role) {
  const c = await cookies();
  const user = db().users.find((u) => u.id === c.get("uid")?.value);
  if (!user) redirect("/login");
  if (role && user.role !== role) redirect("/projects");
  return user;
}

export async function postProject(formData) {
  const user = await requireUser("client");
  const title = formData.get("title")?.toString().trim();
  const desc = formData.get("desc")?.toString().trim();
  if (!title || !desc) redirect("/post");
  const p = {
    id: newId("p"),
    clientId: user.id,
    title,
    titleAr: title,
    desc,
    descAr: desc,
    category: formData.get("category")?.toString() || "development",
    city: formData.get("city")?.toString() || "riyadh",
    budget: Math.max(0, Number(formData.get("budget")) || 0),
    status: "open",
    createdAt: Date.now(),
  };
  db().projects.unshift(p);
  revalidatePath("/projects");
  redirect(`/projects/${p.id}`);
}

export async function submitProposal(formData) {
  const user = await requireUser("freelancer");
  const projectId = formData.get("projectId")?.toString();
  const project = findProject(projectId);
  if (!project || project.status !== "open") redirect("/projects");
  const already = db().proposals.some((pr) => pr.projectId === projectId && pr.freelancerId === user.id);
  if (!already) {
    db().proposals.push({
      id: newId("pr"),
      projectId,
      freelancerId: user.id,
      cover: formData.get("cover")?.toString().trim() || "",
      amount: Math.max(0, Number(formData.get("amount")) || 0),
      days: Math.max(0, Number(formData.get("days")) || 0),
      status: "pending",
      createdAt: Date.now(),
    });
  }
  revalidatePath(`/projects/${projectId}`);
  redirect(`/projects/${projectId}`);
}

export async function acceptProposal(formData) {
  const user = await requireUser("client");
  const proposal = db().proposals.find((pr) => pr.id === formData.get("proposalId")?.toString());
  const project = proposal && findProject(proposal.projectId);
  if (!project) redirect("/projects");
  if (project.clientId === user.id && project.status === "open") {
    project.status = "in_progress";
    project.acceptedProposalId = proposal.id;
    for (const pr of db().proposals.filter((x) => x.projectId === project.id)) {
      pr.status = pr.id === proposal.id ? "accepted" : "rejected";
    }
  }
  revalidatePath(`/projects/${project.id}`);
  redirect(`/projects/${project.id}`);
}

export async function completeProject(formData) {
  const user = await requireUser("client");
  const project = findProject(formData.get("projectId")?.toString());
  if (!project) redirect("/projects");
  if (project.clientId === user.id && project.status === "in_progress") {
    project.status = "completed";
  }
  revalidatePath(`/projects/${project.id}`);
  redirect(`/projects/${project.id}`);
}

export async function updateProfile(formData) {
  const user = await requireUser("freelancer");
  user.name = formData.get("name")?.toString().trim() || user.name;
  user.nameAr = formData.get("nameAr")?.toString().trim() || user.nameAr;
  const rate = Number(formData.get("hourlyRate"));
  if (rate > 0) user.hourlyRate = rate;
  user.skills = (formData.get("skills")?.toString() || "")
    .split(/[,،]/)
    .map((s) => s.trim())
    .filter(Boolean);
  user.bio = formData.get("bio")?.toString().trim();
  revalidatePath("/profile");
  redirect("/profile?saved=1");
}
