/** Agent type ids the app gives itself, shared so the UI can show them with a proper name. */

/** A subagent whose meta file is missing. */
export const UNKNOWN_AGENT_TYPE = 'unknown';
/** `/btw` side questions, which have no meta file. */
export const ASIDE_AGENT_TYPE = 'aside_question';
/** Legacy sidechain lines without an `agentId` are grouped per session under this agent id. */
export const INLINE_AGENT_ID = 'inline';
