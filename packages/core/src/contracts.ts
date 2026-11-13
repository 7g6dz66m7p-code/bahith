export type AgentName = 'planner' | 'discovery' | 'verification' | 'analysis' |
  'citation' | 'writing' | 'critical-review' | 'production';
export type RunState = 'queued' | 'running' | 'awaiting_review' | 'succeeded' | 'failed' | 'cancelled';
export interface RunContext {
  workspaceId: string;
  projectId: string;
  actorId: string;
  runId: string;
  deadline: string;
  budgetMicrousd: number;
}
export interface AgentResult {
  state: RunState;
  claims: { text: string; kind: 'fact' | 'inference' | 'hypothesis'; evidenceIds: string[] }[];
  warnings: string[];
  usage: { inputTokens: number; outputTokens: number; costMicrousd: number };
}
export interface ResearchAgent {
  name: AgentName;
  execute(context: RunContext, input: unknown, signal: AbortSignal): Promise<AgentResult>;
}
const transitions: Record<RunState, readonly RunState[]> = {
  queued: ['running', 'cancelled'],
  running: ['awaiting_review', 'succeeded', 'failed', 'cancelled'],
  awaiting_review: ['succeeded', 'failed', 'cancelled'],
  succeeded: [], failed: [], cancelled: [],
};
export function transition(from: RunState, to: RunState): RunState {
  if (!transitions[from].includes(to)) throw new Error('INVALID_RUN_TRANSITION');
  return to;
}
