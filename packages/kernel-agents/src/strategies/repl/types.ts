// Todo: support number & symbol keys
export type VariableRecord = Record<string, unknown>;

export type EvaluatorState = {
  consts: VariableRecord;
  lets: VariableRecord;
};
