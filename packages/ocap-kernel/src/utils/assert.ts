// Importing from this module substitutes for importing from the @endo/errors
// package.  Bugs in the TypeScript compiler's control flow analysis cause it to
// make incorrect inferences about the behavior of the `Fail` function, as the
// compiler currently handles the `never` return type incorrectly.  We can work
// around the problems this introduces by speaking a falsehood about `Fail`'s
// return type, so that control flow terminations that should have been detected
// but weren't can be reestablished by rewriting occurances of
//
//   Fail`whatever`;
//
// as
//
//   throw Fail`whatever`;
//
// If we do this using `Fail` out of the box, it will trip over the lint rule
// that requires things that are thrown to be Errors, which, of course, `never`
// is not. However, what `Fail` does is throw an Error, so the spirit of the
// rule is maintained, i.e., the consequence of `throw Fail...` is to throw an
// Error, even though it's not actually the throw statement itself that's doing
// the throwing.
//
// This is a ugly hack, which we hope to retire just as soon as the TypeScript
// team fixes the type analysis bug in tsc.  However, we don't know when or even
// if that will happen.

// Note: currently, the only things from `@endo/errors` we actually use are
// `assert` and `Fail`. If we add to that list, those should be incorporated
// here also.

import { assert, Fail as failThatConfusesTypeScript } from '@endo/errors';

export { assert };

// This is simply proxying the normal `Fail`, while substituting a different
// declared return type.  It costs an extra level of function call, but this
// cost is only paid in the failure case.
export const Fail = (
  strings: TemplateStringsArray,
  ...values: unknown[]
): Error => failThatConfusesTypeScript(strings, ...values);
