import React, { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp, Dumbbell, Clock, CheckCircle2, Circle } from "lucide-react";
import ItemCompletionTracker from "@/components/ItemCompletionTracker";

/**
 * WorkoutRoutineCard – Inspired by gym-management-system-laravel's workout routine structure.
 * Displays a day's exercises in a structured format with set/rep tracking.
 */
export default function WorkoutRoutineCard({ day, exercises, onComplete, clientId, trainerId, isTrainer }) {
  const [expanded, setExpanded] = useState(false);
  const [completedSets, setCompletedSets] = useState({});

  const toggleSet = (exerciseIdx, setIdx) => {
    const key = `${exerciseIdx}-${setIdx}`;
    setCompletedSets(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const totalSets = exercises.reduce((sum, e) => sum + (e.sets || 0), 0);
  const completedSetCount = Object.values(completedSets).filter(Boolean).length;
  const allDone = completedSetCount === totalSets && totalSets > 0;

  return (
    <div className="glass-card rounded-xl overflow-hidden bg-card border border-border">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-accent transition-colors"
      >
        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(75,145,221,0.1)', border: '1px solid rgba(75,145,221,0.2)' }}>
          <span className="text-sm font-black text-primary">D{day}</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-foreground text-sm">Day {day}</p>
          <p className="text-xs text-muted-foreground">{exercises.length} exercise{exercises.length !== 1 ? 's' : ''} · {totalSets} sets total</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {allDone && <Badge style={{ background: 'rgba(75,145,221,0.15)', color: '#4B91DD', border: '1px solid rgba(75,145,221,0.3)' }} className="hidden sm:inline-flex">Done ✓</Badge>}
          {completedSetCount > 0 && !allDone && (
            <span className="text-xs text-primary font-medium">{completedSetCount}/{totalSets}</span>
          )}
          {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border divide-y divide-border">
          {exercises.map((exercise, eIdx) => (
            <div key={eIdx} className="p-4 bg-secondary">
              <div className="flex items-start gap-3 mb-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(75,145,221,0.1)', border: '1px solid rgba(75,145,221,0.2)' }}>
                  <Dumbbell className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-foreground text-sm">{exercise.name}</p>
                    {clientId && (
                      <ItemCompletionTracker 
                        clientId={clientId}
                        trainerId={trainerId}
                        type="workout"
                        itemId={`D${day}-${exercise.name}`}
                        isTrainer={isTrainer}
                      />
                    )}
                  </div>
                  <div className="flex gap-3 mt-0.5 flex-wrap">
                    <span className="text-xs text-muted-foreground font-medium">{exercise.sets} × {exercise.reps}</span>
                    {exercise.rest_seconds && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="w-3 h-3" />{exercise.rest_seconds}s rest
                      </span>
                    )}
                    {exercise.target_rir !== undefined && (
                      <span className="text-xs text-primary flex items-center gap-1 font-medium bg-primary/10 px-2 py-0.5 rounded-full border border-primary/20">
                        Target RIR: {exercise.target_rir}
                      </span>
                    )}
                  </div>
                  {exercise.notes && <p className="text-xs text-muted-foreground mt-1 italic">{exercise.notes}</p>}
                </div>
              </div>

              {/* Set trackers */}
              <div className="flex gap-2 flex-wrap ml-11">
                {Array.from({ length: exercise.sets || 0 }).map((_, sIdx) => {
                  const key = `${eIdx}-${sIdx}`;
                  const done = !!completedSets[key];
                  return (
                    <button
                      key={sIdx}
                      onClick={() => toggleSet(eIdx, sIdx)}
                      className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-all font-medium"
                      style={done ? {
                        background: 'rgba(75,145,221,0.15)', color: '#4B91DD', border: '1px solid rgba(75,145,221,0.35)', boxShadow: '0 0 10px rgba(75,145,221,0.1)'
                      } : {
                        background: 'hsl(var(--secondary))', color: 'hsl(var(--muted-foreground))', border: '1px solid hsl(var(--border))'
                      }}
                    >
                      {done ? <CheckCircle2 className="w-3 h-3" /> : <Circle className="w-3 h-3" />}
                      Set {sIdx + 1}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {allDone && (
            <div className="p-4 bg-card">
              <Button
                className="w-full font-bold text-primary border-none transition-all"
                style={{ background: 'linear-gradient(135deg, #4B91DD, #4B91DD)' }}
                onClick={() => onComplete?.({ day, exercises })}
              >
                <CheckCircle2 className="w-4 h-4 mr-2" /> Log Day {day} Complete
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}