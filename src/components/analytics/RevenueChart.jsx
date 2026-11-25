import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ResponsiveLine } from "@nivo/line";
import { DollarSign } from "lucide-react";
import { gymToday } from "@/lib/programs";
import { parseLocalDate } from "@/lib/utils";

const nivoTheme = {
  background: "transparent",
  textColor: "#726B65",
  fontSize: 11,
  axis: {
    domain: { line: { stroke: "rgba(114,107,101,0.15)", strokeWidth: 1 } },
    ticks: { line: { stroke: "rgba(114,107,101,0.15)", strokeWidth: 1 }, text: { fill: "#726B65", fontSize: 11 } },
    legend: { text: { fill: "#726B65", fontSize: 12 } },
  },
  grid: { line: { stroke: "rgba(114,107,101,0.15)", strokeWidth: 1 } },
  tooltip: {
    container: {
      background: "#191615",
      border: "1px solid hsl(var(--border))",
      borderRadius: "10px",
      color: "#E2DEDA",
      fontSize: "12px",
    },
  },
  crosshair: { line: { stroke: "rgba(114,107,101,0.15)", strokeWidth: 1 } },
};

export default function RevenueChart({ payments }) {
  const monthlyRevenue = payments.reduce((acc, payment) => {
    if (payment.status === "completed") {
      const date = parseLocalDate(payment.paid_date || payment.updated_date || payment.created_date || new Date());
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      if (!acc[monthKey]) acc[monthKey] = { month: monthKey, revenue: 0 };
      acc[monthKey].revenue += payment.amount || 0;
    }
    return acc;
  }, {});

  const rawData = Object.values(monthlyRevenue)
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-6)
    .map(item => ({
      x: parseLocalDate(item.month + "-01").toLocaleDateString("en-US", { month: "short" }),
      y: item.revenue,
    }));

  const totalRevenue = payments.filter(p => p.status === "completed").reduce((sum, p) => sum + (p.amount || 0), 0);
  const thisMonthRevenue = payments
    .filter(p => {
      if (p.status !== "completed") return false;
      const date = parseLocalDate(p.paid_date || p.updated_date || p.created_date || new Date());
      const now = gymToday();
      return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
    })
    .reduce((sum, p) => sum + (p.amount || 0), 0);

  const lineData = [{ id: "Revenue", color: "#4B91DD", data: rawData }];

  return (
    <Card className="glass-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <DollarSign className="w-5 h-5 text-primary" />
          Revenue Overview
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="p-4 bg-primary/10 rounded-lg">
            <div className="text-sm text-muted-foreground">Total Revenue</div>
            <div className="text-2xl font-bold text-primary">${totalRevenue.toFixed(2)}</div>
          </div>
          <div className="p-4 bg-primary/10 rounded-lg">
            <div className="text-sm text-muted-foreground">This Month</div>
            <div className="text-2xl font-bold text-primary">${thisMonthRevenue.toFixed(2)}</div>
          </div>
        </div>

        {rawData.length > 0 && (
          <div style={{ height: 250 }}>
            <ResponsiveLine
              data={lineData}
              theme={nivoTheme}
              margin={{ top: 10, right: 20, bottom: 40, left: 55 }}
              xScale={{ type: "point" }}
              yScale={{ type: "linear", min: "auto", max: "auto" }}
              curve="monotoneX"
              axisBottom={{ tickSize: 5, tickPadding: 8 }}
              axisLeft={{ tickSize: 5, tickPadding: 8, format: v => `$${v}` }}
              enableGridX={false}
              colors={["#4B91DD"]}
              lineWidth={3}
              pointSize={8}
              pointColor="#4B91DD"
              pointBorderWidth={2}
              pointBorderColor="#191615"
              enableArea={true}
              areaOpacity={0.15}
              useMesh={true}
              tooltip={({ point }) => (
                <div style={{ background: "#191615", border: "1px solid hsl(var(--border))", borderRadius: 8, padding: "8px 12px", color: "#E2DEDA", fontSize: 12 }}>
                  <strong>{point.data.xFormatted}</strong>: ${Number(point.data.y).toFixed(2)}
                </div>
              )}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}