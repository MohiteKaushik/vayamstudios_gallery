import { useQuery } from "@tanstack/react-query";
import { Download, Mail, MessageCircle, Phone, Search, UserRound, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState, GlassButton, GlassCard, Shimmer } from "@/components/ui-kit";
import { csvFileName, formatPhone, membersToCsv, type MemberRow } from "@/lib/members";
import { api } from "@/lib/api";

/**
 * Client list for the admin console.
 *
 * The data comes from a server function that re-checks the caller's admin role
 * before it reads anything. This component only decides how it looks.
 */
export function MembersPanel() {
  const [query, setQuery] = useState("");

  const members = useQuery({
    queryKey: ["members"],
    queryFn: api.listMembers,
    retry: false,
  });

  const all = useMemo(() => members.data ?? [], [members.data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((m) =>
      [m.fullName, m.email, m.phone].some((v) => v.toLowerCase().includes(q)),
    );
  }, [all, query]);

  function download() {
    if (!all.length) return;
    const blob = new Blob(["﻿" + membersToCsv(all)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = csvFileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success(`Downloaded ${all.length} ${all.length === 1 ? "member" : "members"}`);
  }

  return (
    <section className="mt-12">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-medium uppercase tracking-[0.12em] text-muted-foreground">
          <Users className="size-4" strokeWidth={1.6} />
          Members
          {all.length > 0 && <span className="text-foreground">{all.length}</span>}
        </h2>
        <GlassButton
          size="sm"
          variant="quiet"
          icon={<Download className="size-4" />}
          onClick={download}
          disabled={!all.length}
        >
          Download CSV
        </GlassButton>
      </div>

      {members.isLoading ? (
        <Shimmer className="h-40" />
      ) : members.isError ? (
        <GlassCard className="px-5 py-6">
          <p className="text-sm font-medium">Member list unavailable</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {members.error instanceof Error ? members.error.message : "Could not load members."}
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            Members are read from your R2 bucket. If this keeps failing, check that the bucket
            binding is configured for the deployed Worker.
          </p>
        </GlassCard>
      ) : all.length === 0 ? (
        <EmptyState
          icon={<UserRound className="size-7" strokeWidth={1.5} />}
          title="No members yet"
          description="Once people create accounts, their details and activity show up here."
        />
      ) : (
        <>
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, email or number"
              aria-label="Search members"
              className="h-11 w-full rounded-full border border-hairline bg-background/60 pl-11 pr-5 text-sm outline-none transition focus:ring-2 focus:ring-ring"
            />
          </div>

          {filtered.length === 0 ? (
            <p className="px-1 py-6 text-sm text-muted-foreground">
              No member matches &ldquo;{query}&rdquo;.
            </p>
          ) : (
            <ul className="space-y-2">
              {filtered.map((m) => (
                <li key={m.id}>
                  <MemberCard member={m} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function MemberCard({ member }: { member: MemberRow }) {
  const { fullName, email, phone, hasFaceProfile, photosFound, joinedAt, lastSignInAt } = member;

  const joined = joinedAt ? new Date(joinedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : null;
  const seen = lastSignInAt
    ? new Date(lastSignInAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })
    : "never signed in";

  return (
    <GlassCard className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium tracking-[-0.01em]">{fullName || "Unnamed member"}</p>
          <p className="truncate text-xs text-muted-foreground">{email}</p>
          {phone && (
            <p className="mt-0.5 font-mono text-xs tabular-nums text-muted-foreground">
              {formatPhone(phone)}
            </p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span
              className={
                hasFaceProfile
                  ? "rounded-full bg-secondary px-2 py-0.5 font-medium text-foreground"
                  : "rounded-full bg-secondary px-2 py-0.5"
              }
            >
              {hasFaceProfile ? "Face profile set" : "No face profile"}
            </span>
            <span>{photosFound} {photosFound === 1 ? "photo" : "photos"} found</span>
            {joined && <span>joined {joined}</span>}
            <span>last seen {seen}</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Cta href={`mailto:${email}`} label={`Email ${fullName || email}`}>
            <Mail className="size-4" />
          </Cta>
          {phone && (
            <>
              <Cta href={`tel:+91${phone}`} label={`Call ${fullName || phone}`}>
                <Phone className="size-4" />
              </Cta>
              <Cta
                href={`https://wa.me/91${phone}`}
                label={`Message ${fullName || phone} on WhatsApp`}
                external
              >
                <MessageCircle className="size-4" />
              </Cta>
            </>
          )}
        </div>
      </div>
    </GlassCard>
  );
}

function Cta({
  href,
  label,
  external,
  children,
}: {
  href: string;
  label: string;
  external?: boolean;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      aria-label={label}
      title={label}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className="press inline-flex size-9 items-center justify-center rounded-full bg-secondary text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </a>
  );
}
