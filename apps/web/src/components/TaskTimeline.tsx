// Renders a task's event timeline: conversation turns, collapsed execution
// blocks, system events, and the technical-events section behind StructuredLogTab.

import { useMemo, useState } from "react";
import type {
  TaskEvent
} from "@zenbar/shared";
import { buildExecutionSummary, buildTimelineItems, formatExecutionEventLabel, formatSystemEventLabel, getConversationSpeaker, getEventText } from "../lib/taskEvents";

function ConversationItem({ event, mobile }: { event: TaskEvent; mobile: boolean }) {
  const text = getEventText(event) || "(No message)";
  const speaker = getConversationSpeaker(event);
  return (
    <article className="timeline-item timeline-conversation">
      <div className="row-header">
        <strong>{speaker}</strong>
      </div>
      <p className={mobile ? "event-message conversation-message mobile" : "event-message conversation-message"}>{text}</p>
      <p className="event-meta">
        <span>{new Date(event.created_at).toLocaleTimeString()}</span>
      </p>
    </article>
  );
}

function ExecutionBlock({ events, mobile }: { events: TaskEvent[]; mobile: boolean }) {
  const summary = useMemo(() => buildExecutionSummary(events), [events]);
  const [expanded, setExpanded] = useState(false);

  return (
    <article className="timeline-item timeline-execution">
      <div className="row-header">
        <h3>Execution</h3>
        <button type="button" className="secondary" onClick={() => setExpanded((previous) => !previous)} disabled={events.length === 0}>
          {expanded ? "Collapse" : "Expand"}
        </button>
      </div>

      <div className="execution-summary">
        <p>- ran {summary.commands} commands</p>
        <p>- updated {summary.fileChanges} files</p>
        <p>- generated {summary.diffs} diffs</p>
      </div>

      {expanded ? (
        <ul className={mobile ? "mobile-event-list timeline-details-list" : "event-list timeline-details-list"}>
          {events.map((event) => (
            <li key={event.id}>
              <p className="event-message">{formatExecutionEventLabel(event)}</p>
              <p className="event-meta">
                <span>{new Date(event.created_at).toLocaleTimeString()}</span>
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function SystemEvent({ event }: { event: TaskEvent }) {
  return (
    <article className="timeline-item timeline-system-high">
      <div className="row-header">
        <h3>{formatSystemEventLabel(event)}</h3>
      </div>
      {event.message ? <p className="event-message event-message-agent-status">{event.message}</p> : null}
      <p className="event-meta">
        <span>{new Date(event.created_at).toLocaleTimeString()}</span>
      </p>
    </article>
  );
}

function TechnicalEventsBlock({ events, mobile }: { events: TaskEvent[]; mobile: boolean }) {
  return (
    <details className="timeline-item timeline-technical">
      <summary>View technical events ({events.length})</summary>
      <ul className={mobile ? "mobile-event-list timeline-details-list" : "event-list timeline-details-list"}>
        {events.map((event) => (
          <li key={event.id}>
            <p className="event-message event-message-agent-status">{event.message || event.type.replace(/_/g, " ")}</p>
            <p className="event-meta">
              <span>{new Date(event.created_at).toLocaleTimeString()}</span>
            </p>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function StructuredLogTab({
  events,
  mobile,
  hiddenTechnicalCount,
  onLoadFullTimeline,
  isLoadingFullTimeline
}: {
  events: TaskEvent[];
  mobile: boolean;
  hiddenTechnicalCount: number;
  onLoadFullTimeline: () => void;
  isLoadingFullTimeline: boolean;
}) {
  const items = useMemo(() => buildTimelineItems(events), [events]);

  return (
    <div className="log-timeline">
      {items.map((item) => {
        if (item.kind === "conversation") {
          return <ConversationItem key={item.id} event={item.event} mobile={mobile} />;
        }
        if (item.kind === "execution") {
          return <ExecutionBlock key={item.id} events={item.events} mobile={mobile} />;
        }
        if (item.kind === "system") {
          return <SystemEvent key={item.id} event={item.event} />;
        }
        return <TechnicalEventsBlock key={item.id} events={item.events} mobile={mobile} />;
      })}
      {hiddenTechnicalCount > 0 && (
        // Execution/technical events are excluded from the default fetch
        // (98% of a long task's payload, measured live, for content that's
        // collapsed by default anyway) -- this button fetches the full,
        // unfiltered event list once tapped, which re-renders this same
        // timeline with the execution/technical blocks slotted back into
        // their normal interspersed positions above.
        <button type="button" className="secondary log-timeline-load-full" onClick={onLoadFullTimeline} disabled={isLoadingFullTimeline}>
          {isLoadingFullTimeline ? "불러오는 중..." : `실행 로그 ${hiddenTechnicalCount}건 더 보기`}
        </button>
      )}
    </div>
  );
}
