import React, { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Play, Pause, RotateCcw, Flame, CheckCircle2, Timer } from "lucide-react";

/**
 * FocusTimer – a Pomodoro-style timer for focused training or meal-prep blocks.
 */
const PRESETS = [
  { label: "25 min", seconds: 25 * 60, name: "Focus" },
  { label: "15 min", seconds: 15 * 60, name: "Short" },
  { label: "45 min", seconds: 45 * 60, name: "Deep" },
  { label: "5 min", seconds: 5 * 60, name: "Break" },
];

// Timer status shown in the ring, keyed off the current state.
const TIMER_STATES = {
  idle:    { Icon: Timer,         message: "Ready when you are.",            color: "#4B91DD" },
  running: { Icon: Flame,         message: "Locked in — keep going.",        color: "#4B91DD" },
  paused:  { Icon: Pause,         message: "Paused. Pick it back up.",       color: "#f59e0b" },
  done:    { Icon: CheckCircle2,  message: "Session complete. Nice work.",   color: "#4B91DD" },
};

export default function FocusTimer({ onSessionComplete }) {
  const [preset, setPreset] = useState(PRESETS[0]);
  const [timeLeft, setTimeLeft] = useState(PRESETS[0].seconds);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [sessionsToday, setSessionsToday] = useState(() => {
    const saved = localStorage.getItem('focusSessionsToday');
    const date = localStorage.getItem('focusSessionDate');
    const today = new Date().toDateString();
    return date === today ? parseInt(saved || '0') : 0;
  });
  const intervalRef = useRef(null);

  const status = done ? TIMER_STATES.done
    : running ? TIMER_STATES.running
    : timeLeft < preset.seconds ? TIMER_STATES.paused
    : TIMER_STATES.idle;
  const StatusIcon = status.Icon;

  useEffect(() => {
    if (running && timeLeft > 0) {
      intervalRef.current = setInterval(() => setTimeLeft(t => t - 1), 1000);
    } else if (timeLeft === 0 && running) {
      setRunning(false);
      setDone(true);
      const newCount = sessionsToday + 1;
      setSessionsToday(newCount);
      localStorage.setItem('focusSessionsToday', String(newCount));
      localStorage.setItem('focusSessionDate', new Date().toDateString());
      onSessionComplete?.({ duration_minutes: Math.round(preset.seconds / 60) });
    } else {
      clearInterval(intervalRef.current);
    }
    return () => clearInterval(intervalRef.current);
  }, [running, timeLeft]);

  const selectPreset = (p) => {
    if (running) return;
    setPreset(p);
    setTimeLeft(p.seconds);
    setDone(false);
  };

  const reset = () => {
    clearInterval(intervalRef.current);
    setRunning(false);
    setDone(false);
    setTimeLeft(preset.seconds);
  };

  const minutes = Math.floor(timeLeft / 60);
  const seconds = timeLeft % 60;
  const pct = ((preset.seconds - timeLeft) / preset.seconds) * 100;

  // SVG circle params
  const r = 60;
  const circ = 2 * Math.PI * r;
  const dashOffset = circ * (1 - pct / 100);

  return (
    <div className="glass-card rounded-2xl p-6">
      <div className="flex items-center gap-2 mb-5">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'rgba(75,145,221,0.12)', border: '1px solid rgba(75,145,221,0.25)' }}>
          <Timer className="w-4 h-4 text-primary" />
        </div>
        <div>
          <h3 className="font-bold text-foreground">Focus Timer</h3>
          <p className="text-xs text-muted-foreground">Block out distractions and train with intent</p>
        </div>
        {sessionsToday > 0 && (
          <div className="ml-auto flex items-center gap-1 px-2 py-1 rounded-lg" style={{ background: 'rgba(75,145,221,0.1)', border: '1px solid rgba(75,145,221,0.2)' }}>
            <Flame className="w-3 h-3 text-primary" />
            <span className="text-xs text-primary font-semibold">{sessionsToday} today</span>
          </div>
        )}
      </div>

      {/* Preset selector */}
      <div className="flex gap-2 mb-6">
        {PRESETS.map(p => (
          <button
            key={p.label}
            onClick={() => selectPreset(p)}
            disabled={running}
            className="flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all"
            style={preset.label === p.label ? {
              background: 'rgba(75,145,221,0.15)', color: '#4B91DD', border: '1px solid rgba(75,145,221,0.3)'
            } : {
              background: 'hsl(var(--secondary))', color: 'hsl(var(--muted-foreground))', border: '1px solid hsl(var(--border))'
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Timer ring */}
      <div className="flex flex-col items-center mb-6">
        <div className="relative" style={{ width: 160, height: 160 }}>
          <svg width="160" height="160" className="absolute inset-0 -rotate-90">
            <circle cx="80" cy="80" r={r} fill="none" stroke="hsl(var(--border))" strokeWidth="8" />
            <circle
              cx="80" cy="80" r={r} fill="none"
              stroke={done ? '#4B91DD' : running ? '#4B91DD' : 'rgba(75,145,221,0.3)'}
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={circ}
              strokeDashoffset={dashOffset}
              style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.3s' }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <StatusIcon className="w-7 h-7 mb-1" style={{ color: status.color }} />
            <span className="text-2xl font-black text-foreground tabular-nums">
              {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
            </span>
            <span className="text-xs font-semibold" style={{ color: status.color }}>{preset.name}</span>
          </div>
        </div>

        <p className="text-sm text-center mt-3 font-medium" style={{ color: status.color }}>
          {status.message}
        </p>
      </div>

      {/* Controls */}
      <div className="flex gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={reset}
          className="text-gray-600 hover:text-foreground"
        >
          <RotateCcw className="w-4 h-4" />
        </Button>
        <Button
          onClick={() => { setRunning(r => !r); setDone(false); }}
          className="flex-1 font-bold"
          style={running ? {
            background: 'rgba(239,68,68,0.15)', color: '#f87171', border: '1px solid rgba(239,68,68,0.3)'
          } : {
            background: 'linear-gradient(135deg, #4B91DD, #4B91DD)', color: '#F9F7F6'
          }}
        >
          {running ? <><Pause className="w-4 h-4 mr-2" />Pause</> : <><Play className="w-4 h-4 mr-2" />Start Focus</>}
        </Button>
      </div>

      {done && (
        <div className="mt-4 p-3 rounded-xl text-center" style={{ background: 'rgba(75,145,221,0.08)', border: '1px solid rgba(75,145,221,0.2)' }}>
          <CheckCircle2 className="w-5 h-5 text-primary mx-auto mb-1" />
          <p className="text-primary text-sm font-bold">Session Complete! +{Math.round(preset.seconds / 60)} min focused</p>
        </div>
      )}
    </div>
  );
}