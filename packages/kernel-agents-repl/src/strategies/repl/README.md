# Ocap Kernel REPL Agent

This strategy provides a language model shell that endows an agent with arbitrary javascript definition and invocation capabilities.

## Action Space

An action is a single, unambiguously complete, valid javascript statement. For example, `let x = 10` is valid but not unambiguosly complete, because it could be extended to either `let x = 10;` or `let x = 100`, which effect different consequences. On the other hand `let x = 10;` is unambiguously complete, because extending the string results in the creation of a second javascript statement. Likewise, `function x() {}` is unambiguously complete because any extension is either semantically equivalent or invalid, but `const x = () => {}` is not due to caveats like `const x = () => {} && sideEffect()` or `const x = () => {}.prototype`.

An agent's user conceives of actions as capability invocations like `buyNFT('penguin', ETH(4));`, but other types of statements constitute internal actions the agent can take to compose together its capabilities. Comment statements represent the action of thinking. Elementary mathematics capabilities are available via numeric literals and intrinsic operators. We aim for an agent action space consisting of any single javascript statement.

### REPL Evaluation

Javascript statements are broadly separated into _declarations_, _expressions_, and _everything else_. We can tell them apart using a [parser](./parse/syntax-tree.ts). The parser is supplied by whoever makes the agent: in the host, the native tree-sitter binding, kept in a [worker thread](./parse/tree-sitter-worker-parser.ts) because it cannot initialize in a locked-down realm; in a vat, a client for the host's [parser service](./parse/service.ts), since a native binding cannot be bundled into a vat.

A declaration alters the namespace of the evaluated lexical scope, i.e. `let x;` or `function foo() {}`. Declarations, expressions and everything else can all alter the state of the REPL (by executing code), e.g. `console.log('hello');` or `foo('bar');`, but an expression has an implied return value, e.g. `foo(bar);` might return `3` even though the value was not assigned.

The REPL [evaluator](./evaluator.ts) wraps agent code statements in [helper code](./prepare-evaluation.ts) and evaluates the wrapped code in a [compartment](./compartment.ts). In the case of a declaration, the helper code needs to capture the value of the newly assigned namespace entry or entries. In the case of an expression, the helper code captures the implicit return value of the expression so it can be observed. In any case, the helper code writes the namespace into the scope of the evaluating compartment before agent code evaluation and captures all mutable names of the namespace after agent code evaluation.
