// Functions and objects an earlier module calls from a later one (v52 hoisted them across one script scope).
// Each module registers what is asked of it at its end; nothing is read from here while modules load.
export const late: Record<string, any> = {};
