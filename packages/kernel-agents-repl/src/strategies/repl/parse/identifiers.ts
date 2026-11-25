import type { SyntaxTree } from './syntax-tree.ts';

const extractIdentifiers = (pattern?: SyntaxTree): string[] => {
  if (!pattern) {
    // This would be a tree-sitter error.
    throw new Error('Internal: Declarator missing pattern');
  }

  const identifiers: string[] = [];

  // Handle the case where the pattern itself is an identifier (simple cases like 'const x = 1')
  if (pattern.type === 'identifier') {
    return [pattern.text];
  }

  for (const child of pattern.children) {
    switch (child.type) {
      case 'identifier':
      case 'shorthand_property_identifier_pattern':
        identifiers.push(child.text);
        break;
      default:
        // Recursively handle other pattern types
        if (child.type.endsWith('_pattern')) {
          identifiers.push(...extractIdentifiers(child));
        }
    }
  }

  return identifiers;
};

/**
 * Given a declaration, extract the names of the declared identifiers.
 * These names cover the keys of the namespace delta resulting from evaluation.
 *
 * @param declaration - The declaration to extract the names from.
 *   A declaration is a top level node which is also one of the following:
 *     - a const statement
 *     - a let statement
 *     - a var statement
 *     - a function declaration
 * @returns The names of the identifiers declared in the declaration.
 */
export const extractNamesFromDeclaration = (
  declaration: SyntaxTree,
): string[] => {
  const variableIdentifiers = ({ children }: SyntaxTree): string[] =>
    children
      .filter(({ type }) =>
        ['variable_declarator', 'declarator'].includes(type),
      )
      .flatMap(({ children: [pattern] }) => extractIdentifiers(pattern));
  const functionIdentifier = ({ children }: SyntaxTree): string => {
    const identifier = children.find((child) => child.type === 'identifier');
    if (!identifier) {
      throw new Error('Internal: Function declaration missing identifier');
    }
    return identifier.text;
  };
  switch (declaration.type) {
    case 'lexical_declaration':
    case 'variable_declaration':
      return variableIdentifiers(declaration);
    case 'function_declaration':
    case 'generator_function_declaration':
      return [functionIdentifier(declaration)];
    default:
      throw new Error(`Unknown declaration type: ${declaration.type}`);
  }
};
