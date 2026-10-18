import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const FORBIDDEN_SYMBOL_NAME = "shape";

function containsForbiddenSymbolName(name: string): boolean {
  return name.toLowerCase().includes(FORBIDDEN_SYMBOL_NAME);
}

/** Return whether an identifier names a statically accessed member owned by another value. */
function isBorrowedMemberName(node: ESTree.Node): boolean {
  const parent = node.parent;
  if (parent === null || parent.type !== "MemberExpression") return false;
  return parent.property === node && parent.computed === false;
}

/**
 * Return whether an identifier names something another module or component owns: the name an
 * import reads from its module (`imported`, when renamed away), or a JSX attribute such as
 * Recharts' `shape` prop. Object keys stay checked: most are names the code owns, such as a
 * `Schema.Struct` field, so a key a library owns is written computed, `{ ["shape"]: … }`, which
 * the formatter keeps (it unquotes a plain `"shape"` key back to an identifier).
 */
function isForeignName(node: ESTree.Node): boolean {
  const parent = node.parent;
  if (parent === null) return false;
  if (parent.type === "ImportSpecifier") return parent.imported === node && parent.local !== node;
  return parent.type === "JSXAttribute" && parent.name === node;
}

/** Ban the case-insensitive substring "shape" in every JavaScript and TypeScript symbol name. */
export const noForbiddenTermInSymbolNamesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow the case-insensitive substring "shape" in JavaScript, TypeScript, private, and JSX symbol names.',
    },
    messages: {
      forbiddenSymbolName:
        'Rename symbol "{{name}}" for its domain role; "shape" describes structure rather than ownership.',
    },
  },
  createOnce(context) {
    const reportForbiddenSymbolName = (node: ESTree.Node & { name: string }) => {
      if (
        !containsForbiddenSymbolName(node.name) ||
        isBorrowedMemberName(node) ||
        isForeignName(node)
      ) {
        return;
      }
      context.report({
        node,
        messageId: "forbiddenSymbolName",
        data: { name: node.name },
      });
    };

    return {
      Identifier: reportForbiddenSymbolName,
      PrivateIdentifier: reportForbiddenSymbolName,
      JSXIdentifier: reportForbiddenSymbolName,
    };
  },
});
