// `Compartment` comes from the realm's lockdown; loading `ses` here would
// evaluate the shim a second time, which throws in a locked-down realm.
export type Compartment = { evaluate: (code: string) => unknown };
export const makeCompartment = (
  endowments: Record<string, unknown> = {},
): Compartment => new Compartment(endowments);
