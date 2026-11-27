import type { FunctionDeclaration, Pattern, VariableDeclaration } from 'acorn';

const extractIdentifiers = (pattern: Pattern): string[] => {
  switch (pattern.type) {
    case 'Identifier':
      return [pattern.name];
    case 'ObjectPattern':
      return pattern.properties.flatMap((property) =>
        extractIdentifiers(
          property.type === 'RestElement' ? property.argument : property.value,
        ),
      );
    case 'ArrayPattern':
      return pattern.elements.flatMap((element) =>
        element ? extractIdentifiers(element) : [],
      );
    case 'RestElement':
      return extractIdentifiers(pattern.argument);
    case 'AssignmentPattern':
      return extractIdentifiers(pattern.left);
    case 'MemberExpression':
    default:
      // A declaration cannot bind a member expression; the parser rejects it.
      throw new Error(`Internal: Unexpected pattern type: ${pattern.type}`);
  }
};

/**
 * Given a declaration, extract the names of the declared identifiers.
 * These names cover the keys of the namespace delta resulting from evaluation.
 *
 * @param declaration - The variable or function declaration.
 * @returns The names of the identifiers declared in the declaration.
 */
export const extractNamesFromDeclaration = (
  declaration: VariableDeclaration | FunctionDeclaration,
): string[] =>
  declaration.type === 'VariableDeclaration'
    ? declaration.declarations.flatMap(({ id }) => extractIdentifiers(id))
    : [declaration.id.name];
