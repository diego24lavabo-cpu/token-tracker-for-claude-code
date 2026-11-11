/** Display names of agent types and kinds. */
import { ASIDE_AGENT_TYPE, UNKNOWN_AGENT_TYPE } from '../../shared/agents';
import type { AgentKind } from '../../shared/types';
import { en } from '../i18n/en';

/** The name an agent type is shown with: `/btw` for side questions, the raw type otherwise. */
export function agentTypeLabel(type: string, kind?: AgentKind): string {
  if (kind === 'aside' || type === ASIDE_AGENT_TYPE) return en.agents.asideType;
  if (type === UNKNOWN_AGENT_TYPE) return en.agents.unknownType;
  return type;
}

export function agentKindLabel(kind: Exclude<AgentKind, 'main'>): string {
  return en.agents.kinds[kind];
}
