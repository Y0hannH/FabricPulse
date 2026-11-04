// Per-item-type dispatch over FabricApiService: each item type has its own
// endpoints for runs and schedules, but callers only care about "this item".

import type { ItemType, Pipeline, PipelineRun } from '../models/types';
import type { FabricApiService } from './fabricApi';
import type { ScheduleInfo } from './scheduleService';

export interface ItemRef {
  tenantId: string;
  workspaceId: string;
  itemId: string;
  itemType?: ItemType;
}

export function fetchItemSchedule(
  api: FabricApiService,
  { tenantId, workspaceId, itemId, itemType }: ItemRef,
): Promise<ScheduleInfo | undefined> {
  switch (itemType ?? 'pipeline') {
    case 'semanticModel':
      return api.getSemanticModelSchedule(tenantId, workspaceId, itemId);
    case 'notebook':
      return api.getNotebookSchedule(tenantId, workspaceId, itemId);
    case 'copyJob':
      return api.getCopyJobSchedule(tenantId, workspaceId, itemId);
    case 'dbtJob':
      return api.getDbtJobSchedule(tenantId, workspaceId, itemId);
    default:
      return api.getPipelineSchedule(tenantId, workspaceId, itemId);
  }
}

export function fetchItemLastRun(
  api: FabricApiService,
  { tenantId, workspaceId, itemId, itemType }: ItemRef,
): Promise<PipelineRun | undefined> {
  switch (itemType ?? 'pipeline') {
    case 'semanticModel':
      return api.getLastSemanticModelRun(tenantId, workspaceId, itemId);
    case 'notebook':
      return api.getLastNotebookRun(tenantId, workspaceId, itemId);
    case 'copyJob':
      return api.getLastCopyJobRun(tenantId, workspaceId, itemId);
    case 'dbtJob':
      return api.getLastDbtJobRun(tenantId, workspaceId, itemId);
    default:
      return api.getLastPipelineRun(tenantId, workspaceId, itemId);
  }
}

export function fetchItemRuns(
  api: FabricApiService,
  { tenantId, workspaceId, itemId, itemType }: ItemRef,
): Promise<PipelineRun[]> {
  switch (itemType ?? 'pipeline') {
    case 'semanticModel':
      return api.getSemanticModelRuns(tenantId, workspaceId, itemId);
    case 'notebook':
      return api.getNotebookRuns(tenantId, workspaceId, itemId);
    case 'copyJob':
      return api.getCopyJobRuns(tenantId, workspaceId, itemId);
    case 'dbtJob':
      return api.getDbtJobRuns(tenantId, workspaceId, itemId);
    default:
      return api.getPipelineRuns(tenantId, workspaceId, itemId);
  }
}

/** Deep link to an item in the Fabric portal. Callers pass UUIDs they have already validated. */
export function fabricItemUrl(workspaceId: string, itemId: string, itemType?: ItemType): string {
  switch (itemType ?? 'pipeline') {
    case 'semanticModel':
      return `https://app.fabric.microsoft.com/groups/${workspaceId}/semanticmodels/${itemId}`;
    case 'notebook':
      return `https://app.fabric.microsoft.com/groups/${workspaceId}/synapsenotebooks/${itemId}`;
    case 'copyJob':
      // Best-guess deep link by analogy with the other item types — not
      // documented by Microsoft. Verify against a real tenant and adjust.
      return `https://app.fabric.microsoft.com/groups/${workspaceId}/copyjobs/${itemId}`;
    case 'dbtJob':
      return `https://app.fabric.microsoft.com/groups/${workspaceId}/dbtitems/${itemId}?experience=power-bi`;
    default:
      return `https://app.fabric.microsoft.com/groups/${workspaceId}/pipelines/${itemId}?experience=data-pipeline`;
  }
}

/** Every monitorable item of a workspace. A type whose listing fails (no access,
 *  feature off for the tenant) is skipped rather than failing the workspace. */
export async function listWorkspaceItems(
  api: FabricApiService,
  tenantId: string,
  workspaceId: string,
  workspaceName: string,
): Promise<Pipeline[]> {
  const attempt = async (what: string, call: () => Promise<Pipeline[]>): Promise<Pipeline[]> => {
    try {
      return await call();
    } catch (err) {
      console.warn(`[FabricPulse] Error fetching ${what} for workspace ${workspaceName}:`, err);
      return [];
    }
  };

  // Pipelines first: that call warms up the auth token, so the others reuse it
  // instead of each opening its own sign-in.
  const pipelines = await attempt('pipelines', () => api.getPipelines(tenantId, workspaceId));
  const others = await Promise.all([
    attempt('semantic models', () => api.getSemanticModels(tenantId, workspaceId)),
    attempt('notebooks', () => api.getNotebooks(tenantId, workspaceId)),
    attempt('copy jobs', () => api.getCopyJobs(tenantId, workspaceId)),
    attempt('dbt jobs', () => api.getDbtJobs(tenantId, workspaceId)),
  ]);

  const all = [...pipelines, ...others.flat()];
  for (const item of all) item.workspaceName = workspaceName;
  return all;
}
