import React from "react";
import { parseLocalDate } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { gymToday } from "@/lib/programs";

const COLORS = ['#4B91DD', '#4B91DD', '#4B91DD', '#f59e0b', '#ef4444'];

export function ClientActivityChart({ sessions, clients }) {
  // Group sessions by week
  const last8Weeks = [];
  const today = gymToday();
  
  for (let i = 7; i >= 0; i--) {
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - (i * 7));
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    
    const weekSessions = sessions.filter(s => {
      const sessionDate = parseLocalDate(s.date);
      return sessionDate >= weekStart && sessionDate <= weekEnd;
    });
    
    last8Weeks.push({
      week: `W${8-i}`,
      sessions: weekSessions.length,
      clients: new Set(weekSessions.map(s => s.client_id)).size
    });
  }

  return (
    <Card className="bg-card border-border rounded-3xl">
      <CardHeader>
        <CardTitle className="text-base text-foreground">Client Activity Trend</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={last8Weeks}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(114,107,101,0.18)" />
            <XAxis dataKey="week" stroke="#726B65" />
            <YAxis stroke="#726B65" />
            <Tooltip contentStyle={{ backgroundColor: '#191615', border: '1px solid hsl(var(--border))', color: 'white' }} />
            <Legend wrapperStyle={{ color: 'white' }} />
            <Line type="monotone" dataKey="sessions" stroke="#4B91DD" name="Sessions" strokeWidth={2} />
            <Line type="monotone" dataKey="clients" stroke="#4B91DD" name="Active Clients" strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

export function SessionTypeChart({ sessions }) {
  const sessionTypes = sessions.reduce((acc, s) => {
    acc[s.type] = (acc[s.type] || 0) + 1;
    return acc;
  }, {});

  const data = Object.entries(sessionTypes).map(([type, count]) => ({
    name: type.replace('_', ' '),
    value: count
  }));

  return (
    <Card className="bg-card border-border rounded-3xl">
      <CardHeader>
        <CardTitle className="text-base text-foreground">Session Types Distribution</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              labelLine={false}
              label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
              outerRadius={60}
              fill="#4B91DD"
              dataKey="value"
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

export function CompletionRateChart({ sessions }) {
  const last4Weeks = [];
  const today = gymToday();
  
  for (let i = 3; i >= 0; i--) {
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - (i * 7));
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    
    const weekSessions = sessions.filter(s => {
      const sessionDate = parseLocalDate(s.date);
      return sessionDate >= weekStart && sessionDate <= weekEnd;
    });
    
    const completed = weekSessions.filter(s => s.status === 'completed').length;
    const total = weekSessions.length;
    
    last4Weeks.push({
      week: `Week ${4-i}`,
      completed,
      cancelled: weekSessions.filter(s => s.status === 'cancelled').length,
      no_show: weekSessions.filter(s => s.status === 'no_show').length,
      rate: total > 0 ? ((completed / total) * 100).toFixed(1) : 0
    });
  }

  return (
    <Card className="bg-card border-border rounded-3xl">
      <CardHeader>
        <CardTitle className="text-base text-foreground">Session Completion Rate</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={last4Weeks}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(114,107,101,0.18)" />
            <XAxis dataKey="week" stroke="#726B65" />
            <YAxis stroke="#726B65" />
            <Tooltip contentStyle={{ backgroundColor: '#191615', border: '1px solid hsl(var(--border))', color: 'white' }} />
            <Legend wrapperStyle={{ color: 'white' }} />
            <Bar dataKey="completed" fill="#4B91DD" name="Completed" />
            <Bar dataKey="cancelled" fill="#726B65" name="Cancelled" />
            <Bar dataKey="no_show" fill="#ef4444" name="No Show" />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}