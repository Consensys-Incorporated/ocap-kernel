import type { KernelStore } from '../store/index.ts';
import { insistKernelType } from '../store/utils/kernel-slots.ts';
import type {
  GCAction,
  GCActionType,
  EndpointId,
  KRef,
  RunQueueItem,
} from '../types.ts';
import {
  actionTypePriorities,
  insistGCActionType,
  insistEndpointId,
  insistKRef,
  queueTypeFromActionType,
} from '../types.ts';
import { assert } from '../utils/assert.ts';

/**
 * Parsed representation of a GC action.
 */
type ParsedGCAction = Readonly<{
  endpointId: EndpointId;
  type: GCActionType;
  kref: KRef;
}>;

/**
 * Parse a GC action string into an endpoint id, type, and kref.
 *
 * @param action - The GC action string to parse.
 * @returns The parsed GC action.
 */
function parseAction(action: GCAction): ParsedGCAction {
  const [endpointId, type, kref] = action.split(' ');
  insistEndpointId(endpointId);
  insistGCActionType(type);
  insistKRef(kref);
  insistKernelType('object', kref);
  return harden({ endpointId, type, kref });
}

/**
 * Determines if a GC action should be processed based on current system state.
 *
 * @param storage - The kernel storage.
 * @param endpointId - The endpoint id of the vat or remote that owns the kref.
 * @param type - The type of GC action.
 * @param kref - The kref of the object in question.
 * @returns True if the action should be processed, false otherwise.
 */
function shouldProcessAction(
  storage: KernelStore,
  endpointId: EndpointId,
  type: GCActionType,
  kref: KRef,
): boolean {
  const hasCList = storage.hasCListEntry(endpointId, kref);
  const isReachable = hasCList
    ? storage.getReachableFlag(endpointId, kref)
    : undefined;
  const exists = storage.kernelRefExists(kref);
  const { reachable, recognizable } = exists
    ? storage.getObjectRefCount(kref)
    : { reachable: 0, recognizable: 0 };

  switch (type) {
    case 'dropExport':
      return exists && reachable === 0 && hasCList && isReachable === true;

    case 'retireExport':
      return exists && reachable === 0 && recognizable === 0 && hasCList;

    case 'retireImport':
      return hasCList;

    default:
      return false;
  }
}

/**
 * Filters and processes a group of GC actions for a specific endpoint and action type.
 *
 * @param storage - The kernel storage.
 * @param endpointId - The endpoint id of the vat or remote that owns the krefs.
 * @param actions - The set of GC actions to process.
 * @param allActionsSet - The complete set of GC actions.
 * @returns Object containing the krefs to process and whether the action set was updated.
 */
function filterActionsForProcessing(
  storage: KernelStore,
  endpointId: EndpointId,
  actions: Set<GCAction>,
  allActionsSet: Set<GCAction>,
): { krefs: KRef[]; actionSetUpdated: boolean } {
  const krefs: KRef[] = [];
  let actionSetUpdated = false;

  for (const action of actions) {
    const { type, kref } = parseAction(action);
    if (shouldProcessAction(storage, endpointId, type, kref)) {
      krefs.push(kref);
    }
    allActionsSet.delete(action);
    actionSetUpdated = true;
  }

  // Sorted before hardening, not by the caller afterwards: `harden` freezes the
  // array, and `sort` writes back into it even when it is already in order, so
  // any endpoint with two actions of one type threw out of here and killed the
  // run loop. One vat dropping two exports in a crank is enough.
  krefs.sort();
  return harden({ krefs, actionSetUpdated });
}

/**
 * Process the set of GC actions.
 *
 * @param storage - The kernel storage.
 * @returns The next action to process, or undefined if there are no actions to process.
 */
export function processGCActionSet(
  storage: KernelStore,
): RunQueueItem | undefined {
  const allActionsSet = storage.getGCActions();
  let actionSetUpdated = false;

  // Group actions by endpoint and type
  const actionsByEndpoint = new Map<
    EndpointId,
    Map<GCActionType, Set<GCAction>>
  >();

  for (const action of allActionsSet) {
    const { endpointId, type } = parseAction(action);

    if (!actionsByEndpoint.has(endpointId)) {
      actionsByEndpoint.set(endpointId, new Map());
    }

    const actionsForEndpointByType = actionsByEndpoint.get(endpointId);
    assert(
      actionsForEndpointByType !== undefined,
      `No actions for endpoint: ${endpointId}`,
    );

    if (!actionsForEndpointByType.has(type)) {
      actionsForEndpointByType.set(type, new Set());
    }

    const actions = actionsForEndpointByType.get(type);
    assert(actions !== undefined, `No actions for type: ${type}`);
    actions.add(action);
  }

  // Process actions in priority order
  const endpointIds = Array.from(actionsByEndpoint.keys()).sort();

  for (const endpointId of endpointIds) {
    const actionsForEndpointByType = actionsByEndpoint.get(endpointId);
    assert(
      actionsForEndpointByType !== undefined,
      `No actions for endpoint: ${endpointId}`,
    );

    // Find the highest-priority type of work to do within this endpoint
    for (const type of actionTypePriorities) {
      if (actionsForEndpointByType.has(type)) {
        const actions = actionsForEndpointByType.get(type);
        assert(actions !== undefined, `No actions for type: ${type}`);
        const { krefs, actionSetUpdated: updated } = filterActionsForProcessing(
          storage,
          endpointId,
          actions,
          allActionsSet,
        );

        actionSetUpdated = actionSetUpdated || updated;

        if (krefs.length > 0) {
          // Update the durable set before returning
          storage.setGCActions(allActionsSet);

          const queueType = queueTypeFromActionType.get(type);
          assert(queueType !== undefined, `Unknown action type: ${type}`);

          return harden({ type: queueType, endpointId, krefs });
        }
      }
    }
  }

  if (actionSetUpdated) {
    // Remove negated items from the durable set
    storage.setGCActions(allActionsSet);
  }

  // No GC work to do
  return undefined;
}

harden(processGCActionSet);
