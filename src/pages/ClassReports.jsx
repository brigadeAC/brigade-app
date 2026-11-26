import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChevronLeft, Download, Loader2 } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { todayKey, addDays, fromKey } from "@/lib/programs";
import { invoke, errorMessage, fmtTime, DAY_NAMES, DAY_ORDER, PLAN_KINDS } from "@/components/classes/coach/api";

const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

const fmtDay = (key, opts = { month: "short", day: "numeric" }) => (key ? fromKey(key).toLocaleDateString(undefined, opts) : "");
const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

// Build a CSV file in the browser and save it.
function downloadCsv(name, header, rows) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const text = [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

const axisTick = { fontSize: 11, fill: "hsl(var(--muted-foreground))" };
const tooltipStyle = { background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 12, fontSize: 12 };

function Section({ title, note, onCsv, children }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {note && <p className="text-xs text-muted-foreground mt-0.5">{note}</p>}
        </div>
        {onCsv && (
          <Button variant="outline" size="sm" className="gap-1.5" onClick={onCsv}>
            <Download className="w-4 h-4" /> CSV
          </Button>
        )}
      </div>
      {children}
    </section>
  );
}

function Table({ cols, rows, empty }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground py-2">{empty}</p>;
  return (
    <div className="overflow-x-auto -mx-4 px-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground border-b border-border">
            {cols.map((c) => <th key={c.label} className={`py-2 pr-3 font-medium whitespace-nowrap ${c.num ? "text-right" : ""}`}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key ?? i} className="border-b border-border/60 last:border-0">
              {cols.map((c) => (
                <td key={c.label} className={`py-2 pr-3 ${c.num ? "text-right tabular-nums" : ""} ${c.wrap ? "" : "whitespace-nowrap"}`}>{c.cell(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold text-foreground tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function FillBar({ value }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">No limit</span>;
  return (
    <span className="inline-flex items-center gap-2 justify-end">
      <span className="w-16 sm:w-24 h-2 rounded-full bg-secondary overflow-hidden">
        <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.min(100, value)}%` }} />
      </span>
      <span className="w-9 text-right">{value}%</span>
    </span>
  );
}

export default function ClassReports() {
  const today = todayKey();
  const [range, setRange] = useState({ from: addDays(today, -29), to: today });
  const setFrom = (v) => v && setRange((r) => ({ ...r, from: v }));
  const setTo = (v) => v && setRange((r) => ({ ...r, to: v > today ? today : v }));

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ["classReports", range.from, range.to],
    queryFn: () => invoke("classReports", range),
    enabled: range.from <= range.to,
    placeholderData: (prev) => prev,
  });

  const fileTag = data ? `${data.from}-to-${data.to}` : "";
  const fill = useMemo(() => {
    const order = new Map(DAY_ORDER.map((d, i) => [d, i]));
    return [...(data?.fill || [])].sort((a, b) => order.get(a.dow) - order.get(b.dow) || a.time.localeCompare(b.time));
  }, [data]);
  const noShowMembers = useMemo(
    () => (data?.members || []).filter((m) => m.no_shows || m.late_cancels).sort((a, b) => b.no_shows - a.no_shows || b.late_cancels - a.late_cancels),
    [data]
  );

  const t = data?.totals;
  const activeRange = RANGES.find((r) => range.to === today && range.from === addDays(today, -(r.days - 1)));

  return (
    <div className="space-y-5 pb-8">
      <div>
        <Link to={createPageUrl("Classes")} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" /> Classes
        </Link>
        <h1 className="text-2xl font-bold text-foreground mt-1">Class reports</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Attendance, class fill, no-shows and members by plan.</p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted-foreground">
          From
          <Input type="date" value={range.from} max={range.to} onChange={(e) => setFrom(e.target.value)} className="w-auto h-9 mt-1" />
        </label>
        <label className="text-xs text-muted-foreground">
          To
          <Input type="date" value={range.to} min={range.from} max={today} onChange={(e) => setTo(e.target.value)} className="w-auto h-9 mt-1" />
        </label>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <Button key={r.days} size="sm" variant={activeRange === r ? "default" : "outline"}
              onClick={() => setRange({ from: addDays(today, -(r.days - 1)), to: today })}>
              {r.label}
            </Button>
          ))}
        </div>
        {isFetching && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground mb-2.5" />}
      </div>

      {range.from > range.to ? (
        <p className="text-sm text-red-600">The start date is after the end date.</p>
      ) : isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : isError ? (
        <p className="text-sm text-red-600">{errorMessage(error, "Couldn't load reports.")}</p>
      ) : data && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            <Stat label="Check-ins" value={t.check_ins} sub={`${t.sessions} classes`} />
            <Stat label="Members who came" value={t.members_attended} sub={`of ${t.active_members} active`} />
            <Stat label="Avg class fill" value={t.avg_fill_pct === null ? "–" : `${t.avg_fill_pct}%`} sub="classes with a limit" />
            <Stat label="No-shows" value={t.no_shows} sub={`${pct(t.no_shows, t.booked)}% of bookings`} />
            <Stat label="Not in for 14+ days" value={t.inactive} sub="active members" />
          </div>

          <Tabs defaultValue="attendance" className="space-y-4">
            <TabsList className="bg-card border border-border flex flex-wrap h-auto gap-1 p-1">
              <TabsTrigger value="attendance">Attendance</TabsTrigger>
              <TabsTrigger value="fill">Class fill</TabsTrigger>
              <TabsTrigger value="noshows">No-shows</TabsTrigger>
              <TabsTrigger value="plans">Plans</TabsTrigger>
            </TabsList>

            <TabsContent value="attendance" className="space-y-4">
              <Section title="Check-ins per day" onCsv={() => downloadCsv(`check-ins-by-day-${fileTag}.csv`, ["Date", "Check-ins", "No-shows"], data.daily.map((d) => [d.date, d.check_ins, d.no_shows]))}>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={data.daily} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="date" tick={axisTick} tickFormatter={(d) => fmtDay(d)} minTickGap={16} />
                    <YAxis tick={axisTick} allowDecimals={false} />
                    <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "hsl(var(--secondary))" }} labelFormatter={(d) => fmtDay(d, { weekday: "short", month: "short", day: "numeric" })} />
                    <Bar dataKey="check_ins" name="Check-ins" fill="hsl(var(--chart-1))" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Section>

              <Section title={`Not in for ${data.inactive_days}+ days`} note="Members with an active plan. Counted up to today, not the dates above."
                onCsv={() => downloadCsv(`not-in-${data.inactive_days}-days-${data.today}.csv`, ["Name", "Email", "Plan", "Last check-in", "Days since", "Member since"],
                  data.inactive.map((m) => [m.name, m.email, m.plans, m.last_visit || "Never", m.days_since ?? "", m.member_since || ""]))}>
                <Table empty="Everyone with a plan has been in recently."
                  rows={data.inactive.map((m) => ({ ...m, key: m.client_id }))}
                  cols={[
                    { label: "Name", cell: (m) => m.name },
                    { label: "Plan", cell: (m) => m.plans || "–" },
                    { label: "Last check-in", cell: (m) => (m.last_visit ? fmtDay(m.last_visit) : "Never") },
                    { label: "Days", num: true, cell: (m) => m.days_since ?? "–" },
                  ]} />
              </Section>

              <Section title="By member" onCsv={() => downloadCsv(`attendance-by-member-${fileTag}.csv`, ["Name", "Check-ins", "Booked", "No-shows", "Late cancels", "Last check-in"],
                data.members.map((m) => [m.name, m.check_ins, m.booked, m.no_shows, m.late_cancels, m.last_visit || ""]))}>
                <Table empty="No one booked or checked in during these dates."
                  rows={data.members.map((m) => ({ ...m, key: m.client_id }))}
                  cols={[
                    { label: "Name", cell: (m) => m.name },
                    { label: "Check-ins", num: true, cell: (m) => m.check_ins },
                    { label: "Last check-in", cell: (m) => (m.last_visit ? fmtDay(m.last_visit) : "–") },
                  ]} />
              </Section>

              <Section title="By class" onCsv={() => downloadCsv(`attendance-by-class-${fileTag}.csv`, ["Class", "Classes held", "Check-ins", "Avg per class", "No-shows", "Late cancels"],
                data.classes.map((c) => [c.name, c.sessions, c.check_ins, c.sessions ? (c.check_ins / c.sessions).toFixed(1) : "", c.no_shows, c.late_cancels]))}>
                <Table empty="No classes during these dates."
                  rows={data.classes.map((c) => ({ ...c, key: c.class_type_id }))}
                  cols={[
                    { label: "Class", cell: (c) => c.name },
                    { label: "Held", num: true, cell: (c) => c.sessions },
                    { label: "Check-ins", num: true, cell: (c) => c.check_ins },
                    { label: "Avg per class", num: true, cell: (c) => (c.sessions ? (c.check_ins / c.sessions).toFixed(1) : "–") },
                  ]} />
              </Section>
            </TabsContent>

            <TabsContent value="fill" className="space-y-4">
              <Section title="Class fill by day and time" note="Average spots used against the class limit. Walk-ins count. Open gym is left out."
                onCsv={() => downloadCsv(`class-fill-${fileTag}.csv`, ["Day", "Time", "Class", "Classes held", "Avg booked", "Avg limit", "Fill %", "Times full"],
                  fill.map((f) => [DAY_NAMES[f.dow], f.time, f.name, f.sessions, f.avg_booked, f.avg_capacity ?? "", f.fill_pct ?? "", f.full_sessions]))}>
                <Table empty="No classes with bookings during these dates."
                  rows={fill.map((f) => ({ ...f, key: `${f.dow}-${f.time}-${f.name}` }))}
                  cols={[
                    { label: "Day", cell: (f) => DAY_NAMES[f.dow].slice(0, 3) },
                    { label: "Time", cell: (f) => fmtTime(f.time) },
                    { label: "Class", cell: (f) => f.name },
                    { label: "Avg booked", num: true, cell: (f) => `${f.avg_booked}${f.avg_capacity ? ` / ${f.avg_capacity}` : ""}` },
                    { label: "Fill", num: true, cell: (f) => <FillBar value={f.fill_pct} /> },
                    { label: "Full", num: true, cell: (f) => `${f.full_sessions} of ${f.sessions}` },
                  ]} />
              </Section>
            </TabsContent>

            <TabsContent value="noshows" className="space-y-4">
              <Section title="No-shows by member" note="Booked but didn't check in. Late cancels are cancels inside the late-cancel window."
                onCsv={() => downloadCsv(`no-shows-by-member-${fileTag}.csv`, ["Name", "Booked", "No-shows", "No-show %", "Late cancels"],
                  noShowMembers.map((m) => [m.name, m.booked, m.no_shows, pct(m.no_shows, m.booked), m.late_cancels]))}>
                <Table empty="No no-shows or late cancels during these dates."
                  rows={noShowMembers.map((m) => ({ ...m, key: m.client_id }))}
                  cols={[
                    { label: "Name", cell: (m) => m.name },
                    { label: "Booked", num: true, cell: (m) => m.booked },
                    { label: "No-shows", num: true, cell: (m) => m.no_shows },
                    { label: "Rate", num: true, cell: (m) => `${pct(m.no_shows, m.booked)}%` },
                    { label: "Late cancels", num: true, cell: (m) => m.late_cancels },
                  ]} />
              </Section>
              <Section title="No-shows by class" onCsv={() => downloadCsv(`no-shows-by-class-${fileTag}.csv`, ["Class", "Booked", "No-shows", "No-show %", "Late cancels"],
                data.classes.map((c) => [c.name, c.booked, c.no_shows, pct(c.no_shows, c.booked), c.late_cancels]))}>
                <Table empty="No classes during these dates."
                  rows={data.classes.filter((c) => c.booked || c.late_cancels).map((c) => ({ ...c, key: c.class_type_id }))}
                  cols={[
                    { label: "Class", cell: (c) => c.name },
                    { label: "Booked", num: true, cell: (c) => c.booked },
                    { label: "No-shows", num: true, cell: (c) => c.no_shows },
                    { label: "Rate", num: true, cell: (c) => `${pct(c.no_shows, c.booked)}%` },
                    { label: "Late cancels", num: true, cell: (c) => c.late_cancels },
                  ]} />
              </Section>
            </TabsContent>

            <TabsContent value="plans" className="space-y-4">
              <Section title="Active members by plan" note="Plans that are current today, not the dates above. A member with two plans counts in both."
                onCsv={() => downloadCsv(`members-by-plan-${data.today}.csv`, ["Plan", "Type", "Active members"], data.plans.map((p) => [p.name, PLAN_KINDS[p.kind] || p.kind || "", p.members]))}>
                {data.plans.some((p) => p.members) && (
                  <ResponsiveContainer width="100%" height={Math.max(120, data.plans.length * 36)}>
                    <BarChart data={data.plans} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                      <XAxis type="number" tick={axisTick} allowDecimals={false} />
                      <YAxis type="category" dataKey="name" tick={axisTick} width={110} />
                      <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "hsl(var(--secondary))" }} />
                      <Bar dataKey="members" name="Active members" fill="hsl(var(--chart-1))" radius={[0, 3, 3, 0]} barSize={18} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
                <Table empty="No membership plans yet."
                  rows={data.plans.map((p) => ({ ...p, key: p.plan_id || p.name }))}
                  cols={[
                    { label: "Plan", cell: (p) => p.name },
                    { label: "Type", cell: (p) => PLAN_KINDS[p.kind] || p.kind || "–" },
                    { label: "Active members", num: true, cell: (p) => p.members },
                  ]} />
              </Section>
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
