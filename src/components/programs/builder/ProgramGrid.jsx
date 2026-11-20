import React, { useMemo } from "react";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { Plus, CornerDownRight } from "lucide-react";
import { TYPE_STYLES, typeEmoji, itemTitle, habitRangeLabel, habitEndDay, bySort } from "./itemMeta";

// Week x day grid. Rows = weeks, columns = Day 1..7. Each cell lists that day's
// items as chips; habits also show a light "continuing" marker on later days.
// Drag a chip to another cell to move it (desktop; long-press on touch).
export default function ProgramGrid({ weeks, items, onAdd, onEdit, onMove }) {
  const totalDays = weeks * 7;

  const byDay = useMemo(() => {
    const map = {};
    for (const i of items) {
      const d = Number(i.day) || 1;
      (map[d] ||= []).push(i);
    }
    Object.values(map).forEach((list) => list.sort(bySort));
    return map;
  }, [items]);

  const habits = useMemo(() => items.filter((i) => i.type === "habit"), [items]);
  const continuingOn = (day) =>
    habits.filter((h) => Number(h.day) < day && habitEndDay(h, totalDays) >= day);

  const handleDragEnd = ({ draggableId, source, destination }) => {
    if (!destination) return;
    const toDay = Number(destination.droppableId.replace("day-", ""));
    const fromDay = Number(source.droppableId.replace("day-", ""));
    if (toDay === fromDay && destination.index === source.index) return;
    onMove(draggableId, toDay, destination.index);
  };

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        <div className="grid min-w-[880px]" style={{ gridTemplateColumns: "52px repeat(7, minmax(118px, 1fr))" }}>
          <div className="sticky left-0 z-10 bg-card border-b border-r border-border" />
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="px-2 py-2 text-xs font-medium text-muted-foreground border-b border-border text-center">
              Day {i + 1}
            </div>
          ))}

          {Array.from({ length: weeks }, (_, w) => (
            <React.Fragment key={w}>
              <div className="sticky left-0 z-10 bg-card border-r border-b border-border flex items-start justify-center pt-2">
                <span className="text-xs font-semibold text-foreground">Wk {w + 1}</span>
              </div>
              {Array.from({ length: 7 }, (_, d) => {
                const day = w * 7 + d + 1;
                return (
                  <DayCell
                    key={day}
                    day={day}
                    dayOfWeek={d + 1}
                    week={w + 1}
                    items={byDay[day] || []}
                    continuing={continuingOn(day)}
                    totalDays={totalDays}
                    onAdd={onAdd}
                    onEdit={onEdit}
                  />
                );
              })}
            </React.Fragment>
          ))}
        </div>
      </div>
    </DragDropContext>
  );
}

function DayCell({ day, week, dayOfWeek, items, continuing, totalDays, onAdd, onEdit }) {
  const handleClick = (e) => {
    if (e.target.closest("[data-chip]")) return;
    onAdd(day);
  };
  return (
    <div
      onClick={handleClick}
      className={`group relative border-b border-border ${dayOfWeek < 7 ? "border-r" : ""} p-1.5 min-h-[96px] flex flex-col gap-1 cursor-pointer hover:bg-accent/30 transition-colors`}
    >
      {continuing.map((h) => (
        <button
          key={`c-${h.id}`}
          type="button"
          data-chip
          onClick={() => onEdit(h)}
          title={`${itemTitle(h)} continues (${habitRangeLabel(h, totalDays)})`}
          className="flex items-center gap-1 text-[10px] text-muted-foreground/80 px-1 rounded hover:text-foreground text-left"
        >
          <CornerDownRight className="w-3 h-3 shrink-0" />
          <span className="truncate">{typeEmoji("habit")} {itemTitle(h)}</span>
        </button>
      ))}
      <Droppable droppableId={`day-${day}`}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={`flex-1 flex flex-col gap-1 rounded-md min-h-[40px] ${snapshot.isDraggingOver ? "bg-primary/10 ring-1 ring-primary/40" : ""}`}
          >
            {items.map((item, index) => (
              <Draggable key={item.id} draggableId={String(item.id)} index={index} isDragDisabled={!!item._pending}>
                {(p, s) => (
                  <div
                    ref={p.innerRef}
                    {...p.draggableProps}
                    {...p.dragHandleProps}
                    data-chip
                    onClick={() => onEdit(item)}
                    onKeyDown={(e) => {
                      p.dragHandleProps?.onKeyDown?.(e);
                      if (e.key === "Enter") onEdit(item);
                    }}
                    aria-label={`${itemTitle(item)}, Week ${week} Day ${dayOfWeek}. Press Enter to edit.`}
                    className={`text-left rounded-md border px-1.5 py-1 text-[11px] leading-tight ${TYPE_STYLES[item.type] || "border-border"} ${s.isDragging ? "shadow-lg" : ""} ${item._pending ? "opacity-60" : ""}`}
                  >
                    <span className="flex items-start gap-1">
                      <span className="shrink-0">{typeEmoji(item.type)}</span>
                      <span className="line-clamp-2 break-words font-medium">{itemTitle(item)}</span>
                    </span>
                    {item.type === "habit" && (
                      <span className="block text-[10px] opacity-70 mt-0.5">{habitRangeLabel(item, totalDays)}</span>
                    )}
                    {item.type === "message" && item.send_time && (
                      <span className="block text-[10px] opacity-70 mt-0.5">{item.send_time}</span>
                    )}
                  </div>
                )}
              </Draggable>
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
      <span
        aria-hidden
        className="self-center text-muted-foreground/50 group-hover:text-muted-foreground"
      >
        <Plus className="w-3.5 h-3.5" />
      </span>
      <button type="button" className="sr-only" onClick={(e) => { e.stopPropagation(); onAdd(day); }}>
        Add to Week {week}, Day {dayOfWeek}
      </button>
    </div>
  );
}
