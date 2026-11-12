import { X } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import type { SessionDetail, SessionSubagent, TokenBreakdown } from '../../shared/types';
import { useToday } from '../hooks/useToday';
import { useUsageQuery } from '../hooks/useUsageQuery';
import { en } from '../i18n/en';
import { agentKindLabel, agentTypeLabel } from '../lib/agents';
import {
  formatCost,
  formatDay,
  formatDuration,
  formatInt,
  formatPercent,
  formatTokens,
} from '../lib/format';
import { SplitBar } from './SplitBar';

const NO_VALUE = '—';
const d = en.sessions.drawer;
const TOKEN_TYPES = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

interface SessionDrawerProps {
  machineId: string;
  sessionId: string;
  /** From the table row, to name the drawer before its data arrives. */
  project: string;
  onClose: () => void;
}

const sum = (tokens: TokenBreakdown) =>
  tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead;

/**
 * The detail of one session: when and how long, main vs subagent tokens, then the
 * timeline of its subagent invocations. Next to the table on a wide window, over its
 * right side otherwise; Escape closes it.
 */
export function SessionDrawer({ machineId, sessionId, project, onClose }: SessionDrawerProps) {
  const fetchDetail = useCallback(
    () => window.api.getSessionDetail(machineId, sessionId),
    [machineId, sessionId],
  );
  const { data, loading } = useUsageQuery(fetchDetail);
  const ref = useRef<HTMLElement>(null);

  // The drawer takes the focus when it opens on a new session, so the keyboard follows.
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [machineId, sessionId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // While the next session loads, the previous one stays, dimmed.
  const detail = data ?? null;

  return (
    <aside
      ref={ref}
      className={loading ? 'card session-drawer is-loading' : 'card session-drawer'}
      aria-label={d.label(detail?.project ?? project)}
      aria-busy={loading}
      tabIndex={-1}
    >
      <header className="session-drawer-header">
        <div className="session-drawer-heading">
          <h2 className="card-title">
            {d.title} ·{' '}
            <span className="session-drawer-project num">{detail?.project ?? project}</span>
          </h2>
          {detail && <Started detail={detail} />}
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={d.close}
          title={d.close}
          onClick={onClose}
        >
          <X size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      </header>

      {!loading && data === null ? (
        <p className="panel-empty">{d.missing}</p>
      ) : (
        detail && (
          <>
            <Stats detail={detail} />
            <Split detail={detail} />
            <Timeline detail={detail} />
          </>
        )
      )}
    </aside>
  );
}

function Started({ detail }: { detail: SessionDetail }) {
  const today = useToday();
  const day = formatDay(detail.startDay, {
    weekday: true,
    year: detail.startDay.slice(0, 4) !== today.slice(0, 4),
  });
  return (
    <p className="card-hint num">
      {day} · {detail.startTime} · {detail.machine}
    </p>
  );
}

function Stats({ detail }: { detail: SessionDetail }) {
  const tokens = sum(detail.main) + sum(detail.subagentTokens);
  const stats: { label: string; value: string; title?: string; accent?: boolean }[] = [
    { label: d.active, value: formatDuration(detail.activeMs), title: d.activeHint },
    { label: d.span, value: formatDuration(detail.spanMs), title: d.spanHint },
    { label: d.tokens, value: formatTokens(tokens) },
    {
      label: d.cost,
      value: formatCost(detail.cost),
      title: detail.costIsPartial ? d.costPartial : undefined,
    },
    { label: d.messages, value: formatInt(detail.messages) },
    { label: d.subagents, value: formatInt(detail.subagentCount) },
    { label: d.model, value: detail.model || NO_VALUE, accent: true },
  ];
  if (detail.projects.length > 1) {
    stats.push({
      label: d.projects,
      value: detail.projects.map((item) => `${item.name} ${formatPercent(item.share)}`).join(' · '),
    });
  }

  return (
    <dl className="session-stats">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className={stat.label === d.projects ? 'session-stat session-stat--wide' : 'session-stat'}
          title={stat.title}
        >
          <dt>{stat.label}</dt>
          <dd className={stat.accent ? 'num cell-accent' : 'num'}>{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Split({ detail }: { detail: SessionDetail }) {
  const main = sum(detail.main);
  const subagents = sum(detail.subagentTokens);
  const total = main + subagents;
  const share = (value: number) => (total > 0 ? value / total : 0);

  return (
    <section className="panel-block">
      <h3 className="panel-block-title">{d.split}</h3>
      <SplitBar
        label={d.splitLabel}
        parts={[
          { key: 'main', label: d.main, tokens: main, share: share(main) },
          { key: 'subagents', label: d.subagentsPart, tokens: subagents, share: share(subagents) },
        ]}
      />
      <table className="session-types">
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">{d.tokens}</span>
            </th>
            <th scope="col">{d.main}</th>
            <th scope="col">{d.subagentsPart}</th>
          </tr>
        </thead>
        <tbody>
          {TOKEN_TYPES.map((type) => (
            <tr key={type}>
              <th scope="row">{d.types[type]}</th>
              <td className="num">{formatTokens(detail.main[type])}</td>
              <td className="num">{formatTokens(detail.subagentTokens[type])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Timeline({ detail }: { detail: SessionDetail }) {
  const { from, to } = detail.timeline;
  const length = Math.max(1, to - from);
  const position = (start: number, end: number) => ({
    left: `${((start - from) / length) * 100}%`,
    width: `${((end - start) / length) * 100}%`,
  });

  return (
    <section className="panel-block">
      <h3 className="panel-block-title">
        {d.timeline}
        {detail.subagents.length > 0 && (
          <span className="chart-card-hint num">{formatInt(detail.subagents.length)}</span>
        )}
      </h3>
      {detail.subagents.length === 0 ? (
        <p className="panel-empty">{d.noSubagents}</p>
      ) : (
        <ol className="session-timeline" aria-label={d.timelineLabel}>
          {detail.subagents.map((agent) => (
            <TimelineItem
              key={agent.agentId}
              agent={agent}
              sessionDay={detail.startDay}
              bar={position(agent.start, agent.end)}
              session={position(detail.start, detail.end)}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

interface TimelineItemProps {
  agent: SessionSubagent;
  sessionDay: string;
  bar: { left: string; width: string };
  session: { left: string; width: string };
}

function TimelineItem({ agent, sessionDay, bar, session }: TimelineItemProps) {
  const start =
    agent.startDay === sessionDay
      ? agent.startTime
      : `${formatDay(agent.startDay)} · ${agent.startTime}`;
  return (
    <li className={agent.kind === 'warmup' ? 'timeline-item is-warmup' : 'timeline-item'}>
      <div className="timeline-head">
        <span className="timeline-type">{agentTypeLabel(agent.type, agent.kind)}</span>
        <span className="timeline-kind">{agentKindLabel(agent.kind)}</span>
        <span className="timeline-start num">{start}</span>
      </div>
      <div className="timeline-track" aria-hidden="true">
        <span className="timeline-session" style={session} />
        <span className="timeline-bar" style={bar} />
      </div>
      <div className="timeline-meta num">
        <span>{formatDuration(agent.activeMs)}</span>
        <span className="timeline-tokens">{formatTokens(agent.tokens)}</span>
        <span className="cell-accent">{agent.model}</span>
        <span>{d.calls(agent.calls)}</span>
        <span>{d.startup(formatTokens(agent.startupInput))}</span>
      </div>
    </li>
  );
}
