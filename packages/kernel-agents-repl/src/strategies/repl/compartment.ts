// `Compartment` is a global of any realm that has run lockdown, whether the
// host's start compartment or a vat's. The REPL never loads `ses` itself:
// evaluating the shim a second time in a locked-down realm throws.
export type Compartment = { evaluate: (code: string) => unknown };
export const makeCompartment = (
  endowments: Record<string, unknown> = {},
): Compartment => new Compartment(endowments);
