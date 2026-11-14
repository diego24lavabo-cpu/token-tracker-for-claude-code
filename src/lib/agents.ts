/** Display names of agent types and kinds. */
import { ASIDE_AGENT_TYPE, INLINE_AGENT_ID, UNKNOWN_AGENT_TYPE } from '../../shared/agents';
import type { AgentKind } from '../../shared/types';
import { strings } from '../i18n';

/** The name an agent type is shown with: `/btw` for side questions, the raw type otherwise. */
export function agentTypeLabel(type: string, kind?: AgentKind): string {
  if (kind === 'aside' || type === ASIDE_AGENT_TYPE) return strings.agents.asideType;
  if (type === UNKNOWN_AGENT_TYPE) return strings.agents.unknownType;
  return type;
}

/**
 * The name of one run: legacy inline sidechain lines without an agent id, grouped per
 * session, are named as such; any other run by its type.
 */
export function agentRunLabel(agentId: string, type: string, kind?: AgentKind): string {
  if (agentId === INLINE_AGENT_ID) return strings.agents.inlineRun;
  return agentTypeLabel(type, kind);
}

export function agentKindLabel(kind: Exclude<AgentKind, 'main'>): string {
  return strings.agents.kinds[kind];
}

/** The capitalized name of a kind, for badges and headings. */
export function agentKindName(kind: Exclude<AgentKind, 'main'>): string {
  return strings.agents.kindNames[kind];
}
