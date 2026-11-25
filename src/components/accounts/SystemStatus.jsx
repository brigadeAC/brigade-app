import React from "react";
import { useQuery } from "@tanstack/react-query";
import { accountCall } from "./api";

const when = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const Row = ({ ok, label, text }) => (
  <p className="flex items-start gap-2 text-sm text-foreground">
    <span aria-hidden="true" className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${ok ? "bg-emerald-500" : "bg-amber-500"}`} />
    <span><span className="font-semibold">{label}:</span> {text}</span>
  </p>
);

export default function SystemStatus() {
  const { data, error } = useQuery({ queryKey: ["systemStatus"], queryFn: () => accountCall("systemStatus"), refetchInterval: 60000, retry: false });
  if (error) return <p className="text-sm text-red-600">{error.message}</p>;
  if (!data) return null;
  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-3">
      <h2 className="text-base font-semibold text-foreground">System status</h2>
      <Row ok={data.cron_ok} label="Scheduled job" text={data.cron_last_ok ? `last ran ${when(data.cron_last_ok)}` : "hasn't reported yet"} />
      <Row ok={data.email_enabled} label="Email" text={data.email_enabled ? "connected" : "not connected"} />
      <Row ok={data.errors.length === 0} label="Errors, last 30 days" text={data.errors.length ? `${data.errors.length} different` : "none"} />
      {data.errors.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {data.errors.map((e) => (
            <li key={e.id} className="p-3 text-xs">
              <p className="text-foreground break-words">{e.message}</p>
              <p className="text-muted-foreground mt-0.5">{e.page || e.source} · {e.hits} {e.hits === 1 ? "time" : "times"} · last {when(e.last_seen)}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
