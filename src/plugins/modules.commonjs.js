import type Module from '../module';
import { Binding, ExportSpecifierListStringBuilder, ImportSpecifierListStringBuilder } from '../bindings';
import { Syntax, VisitorOption } from 'estraverse';

export const name = 'modules.commonjs';
export const description = 'Transform CommonJS modules into ES6 modules.';

export function begin(module: Module): Context {
  module.metadata[name] = {
    imports: [],
    exports: [],
    directives: []
  };
  return new Context(module);
}

type ImportMetadata = {
  type: string,
  node: Object,
  bindings: Array<Binding>,
  path: string
};

type ExportMetadata = {
  type: string,
  node: Object,
  bindings: Array<Binding>
};

type DirectiveMetadata = {
  type: string,
  node: Object
};

type Metadata = {
  imports: Array<ImportMetadata>,
  exports: Array<ExportMetadata>,
  directives: Array<DirectiveMetadata>
};

export function enter(node: Object, parent: Object, module: Module, context: Context): ?VisitorOption {
  if (/Function/.test(node.type) || context.rewrite(node, parent)) {
    return VisitorOption.Skip;
  }
}

class Context {
  constructor(module: Module) {
    this.module = module;
  }

  get metadata(): Metadata {
    return this.module.metadata[name];
  }

  rewrite(node: Object, parent: Object): boolean {
    return (
      this.rewriteRequire(node, parent) ||
      this.rewriteExport(node, parent) ||
      this.removeUseStrictDirective(node, parent)
    );
  }

  /**
   * @private
   */
  rewriteRequire(node: Object, parent: Object): boolean {
    return (
      this.rewriteSingleExportRequire(node, parent) ||
      this.rewriteNamedExportRequire(node, parent) ||
      this.rewriteDeconstructedImportRequire(node, parent) ||
      this.rewriteSideEffectRequire(node, parent) ||
      this.warnAboutUnsupportedRequire(node, parent)
    );
  }

  /**
   * @private
   */
  rewriteSingleExportRequire(node: Object, parent: Object): boolean {
    const declaration = extractSingleDeclaration(node);

    if (!declaration) {
      return false;
    }

    const { id, init } = declaration;

    if (id.type !== Syntax.Identifier) {
      return false;
    }

    const pathNode = extractRequirePathNode(init);

    if (!pathNode) {
      return false;
    }

    this.rewriteRequireAsImport(
      'default-import',
      node,
      [new Binding(id.name, 'default')],
      pathNode
    );

    return true;
  }

  /**
   * @private
   */
  rewriteNamedExportRequire(node: Object, parent: Object): boolean {
    const declaration = extractSingleDeclaration(node);

    if (!declaration) {
      return false;
    }

    const { id, init } = declaration;

    if (!init || init.type !== Syntax.MemberExpression || init.computed) {
      return false;
    }

    const pathNode = extractRequirePathNode(init.object);

    if (!pathNode) {
      return false;
    }

    this.rewriteRequireAsImport(
      'named-import',
      node,
      [new Binding(id.name, init.property.name)],
      pathNode
    );

    return true;
  }

  /**
   * @private
   */
  rewriteDeconstructedImportRequire(node: Object, parent: Object): boolean {
    const declaration = extractSingleDeclaration(node);

    if (!declaration) {
      return false;
    }

    const { id, init } = declaration;

    if (id.type !== Syntax.ObjectPattern) {
      return false;
    }

    const bindings = [];

    for (let { key, value } of id.properties) {
      if (value.type !== Syntax.Identifier) {
        return false;
      }
      bindings.push(new Binding(value.name, key.name));
    }

    const pathNode = extractRequirePathNode(init);

    if (!pathNode) {
      return false;
    }

    this.rewriteRequireAsImport('named-import', node, bindings, pathNode);

    return true;
  }

  /**
   * @private
   */
  rewriteSideEffectRequire(node: Object, parent: Object): boolean {
    if (node.type !== Syntax.ExpressionStatement) {
      return false;
    }

    const pathNode = extractRequirePathNode(node.expression);

    if (!pathNode) {
      return false;
    }

    this.rewriteRequireAsImport('bare-import', node, [], pathNode);

    return true;
  }

  /**
   * @private
   */
  warnAboutUnsupportedRequire(node: Object, parent: Object): boolean {
    const pathNode = extractRequirePathNode(node);

    if (!pathNode) {
      return false;
    }

    this.module.warn(
      node,
      'unsupported-require',
      `Unsupported 'require' call cannot be transformed to an import`
    );

    return true;
  }

  /**
   * @private
   */
  rewriteRequireAsImport(type: string, node: Object, bindings: Array<Binding>, pathNode: Object) {
    this.metadata.imports.push({
      type,
      node,
      bindings,
      path: pathNode.value
    });

    const pathString = this.slice(...pathNode.range);
    if (bindings.length === 0) {
      this.overwrite(
        node.range[0],
        node.range[1],
        `import ${pathString};`
      );
    } else {
      this.overwrite(
        node.range[0],
        node.range[1],
        `import ${ImportSpecifierListStringBuilder.build(bindings)} from ${pathString};`
      );
    }
  }

  /**
   * @private
   */
  rewriteExport(node: Object, parent: Object): boolean {
    return (
      this.rewriteNamedExport(node, parent) ||
      this.rewriteSingleExportAsDefaultExport(node, parent)
    );
  }

  /**
   * @private
   */
  rewriteNamedExport(node: Object, parent: Object): boolean {
    if (node.type !== Syntax.ExpressionStatement) {
      return false;
    }

    const { expression } = node;

    if (expression.type !== Syntax.AssignmentExpression) {
      return false;
    }

    const { left, right } = expression;

    if (left.type !== Syntax.MemberExpression || left.computed) {
      return false;
    }

    const { object, property } = left;

    if (object.type !== Syntax.Identifier || object.name !== 'exports') {
      return false;
    }

    if (right.type === Syntax.FunctionExpression) {
      const exportName = property.name;

      this.metadata.exports.push({
        bindings: [
          {
            exportName,
            localName: right.id ? right.id.name : exportName
          }
        ],
        node
      });

      this.overwrite(node.range[0], right.range[0], 'export ');

      if (!right.id) {
        this.insert(right.range[0] + 'function'.length, ` ${exportName}`);
      } else if (right.id.name !== property.name) {
        this.overwrite(right.id.range[0], right.id.range[1], property.name);
        this.module.warn(
          right.id,
          'export-function-name-mismatch',
          `Exported function '${right.id.name}' does not match export name '${exportName}'`
        );
      }

      const lastCharacterPosition = node.range[1] - 1;
      if (this.charAt(lastCharacterPosition) === ';') {
        this.remove(lastCharacterPosition, node.range[1]);
      }
    } else if (right.type === Syntax.Identifier) {
      this.metadata.exports.push({
        type: 'named-export',
        bindings: [
          {
            exportName: property.name,
            localName: right.name
          }
        ],
        node
      });

      if (right.name === property.name) {
        this.overwrite(node.range[0], node.range[1], `export { ${right.name} };`);
      } else {
        this.overwrite(node.range[0], node.range[1], `export { ${right.name} as ${property.name} };`);
      }
    } else {
      if (this.module.scope.globalScope.isUsedName(property.name)) {
        this.module.warn(
          property,
          'named-export-conflicts-with-local-binding',
          `Named export '${property.name}' conflicts with existing local binding`
        );
      }

      this.metadata.exports.push({
        type: 'named-export',
        bindings: [
          {
            exportName: property.name,
            localName: property.name
          }
        ],
        node
      });

      this.overwrite(node.range[0], property.range[0], 'export let ');
    }

    return true;
  }

  /**
   * @private
   */
  rewriteSingleExportAsDefaultExport(node: Object, parent: Object): boolean {
    if (node.type !== Syntax.ExpressionStatement) {
      return false;
    }

    const { expression } = node;

    if (expression.type !== Syntax.AssignmentExpression) {
      return false;
    }

    const { left, right } = expression;

    if (left.type !== Syntax.MemberExpression || left.computed) {
      return false;
    }

    const { object, property } = left;

    if (object.type !== Syntax.Identifier || object.name !== 'module') {
      return false;
    }

    if (property.type !== Syntax.Identifier || property.name !== 'exports') {
      return false;
    }

    if (right.type === 'ObjectExpression') {
      const bindings = [];
      for (let { key, value } of right.properties) {
        bindings.push(new Binding(value.name, key.name));
      }
      this.metadata.exports.push({
        type: 'named-export',
        bindings: bindings,
        node
      });
      this.overwrite(node.range[0], node.range[1], `export ${ExportSpecifierListStringBuilder.build(bindings)};`);
    } else {
      this.metadata.exports.push({ type: 'default-export', node });
      this.overwrite(node.range[0], right.range[0], 'export default ');
    }

    return true;
  }

  /**
   * @private
   */
  removeUseStrictDirective(node: Object, parent: Object): boolean {
    if (node.type !== Syntax.ExpressionStatement) {
      return false;
    }

    const { expression } = node;

    if (expression.type !== Syntax.Literal) {
      return false;
    }

    if (expression.value !== 'use strict') {
      return false;
    }

    if (parent.body[0] !== node) {
      return false;
    }

    let [ start, end ] = node.range;

    if ((start === 0 || this.charAt(start - '\n'.length) === '\n') && this.charAt(end) === '\n') {
      end += '\n'.length;
    }

    this.metadata.directives.push({
      type: 'removed-strict-mode',
      node
    });

    this.remove(start, end);
    return true;
  }

  /**
   * @private
   */
  charAt(index: number): string {
    return this.module.magicString.original[index];
  }

  /**
   * @private
   */
  slice(start: number, end: number): string {
    return this.module.magicString.original.slice(start, end);
  }

  /**
   * @private
   */
  remove(start: number, end: number) {
    this.module.magicString.remove(start, end);
  }

  /**
   * @private
   */
  overwrite(start: number, end: number, content: string) {
    this.module.magicString.overwrite(start, end, content);
  }

  /**
   * @private
   */
  insert(index: number, content: string) {
    return this.module.magicString.insert(index, content);
  }
}

function extractSingleDeclaration(node: Object): ?Object {
  if (node.type !== Syntax.VariableDeclaration) {
    return null;
  }

  if (node.declarations.length !== 1) {
    return null;
  }

  return node.declarations[0];
}

function extractRequirePathNode(node: Object): ?Object {
  if (!node || node.type !== Syntax.CallExpression) {
    return null;
  }

  if (node.callee.type !== Syntax.Identifier || node.callee.name !== 'require') {
    return null;
  }

  if (node.arguments.length !== 1) {
    return null;
  }

  const arg = node.arguments[0];

  if (arg.type !== Syntax.Literal || typeof arg.value !== 'string') {
    return null;
  }

  return arg;
}