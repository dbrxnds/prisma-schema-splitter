import * as fs from "fs"
import * as path from "path"
import * as ts from "typescript"

const BASE_SCHEMA_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../node_modules/@prisma/client-mysql",
)
const inputFilePath = path.resolve(BASE_SCHEMA_PATH, "index.d.ts")
const outputDir = path.resolve(BASE_SCHEMA_PATH, "types")
const indexFilePath = path.resolve(outputDir, "index.ts")

function ensureOutputDirectory() {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }
}

function readInputFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, "utf-8", (err, data) => {
      if (err) {
        reject(err)
      } else {
        resolve(data)
      }
    })
  })
}

function collectTypeDependencies(sourceFile: ts.SourceFile): Map<string, Set<string>> {
  const typeDependencies = new Map<string, Set<string>>()

  sourceFile.forEachChild((node) => {
    if (
      ts.isModuleDeclaration(node) &&
      node.name.text === "Prisma" &&
      node.body &&
      ts.isModuleBlock(node.body)
    ) {
      node.body.statements.forEach((statement) =>
        collectTypeDependenciesFromNode(statement, typeDependencies),
      )
    } else {
      collectTypeDependenciesFromNode(node, typeDependencies)
    }
  })

  return typeDependencies
}

function collectTypeDependenciesFromNode(
  node: ts.Node,
  typeDependencies: Map<string, Set<string>>,
) {
  if (
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isClassDeclaration(node)
  ) {
    if (!node.name) return
    const typeName = node.name.text
    const dependencies = new Set<string>()

    const collectDependencies = (childNode: ts.Node) => {
      if (ts.isTypeReferenceNode(childNode)) {
        if (ts.isIdentifier(childNode.typeName)) {
          dependencies.add(childNode.typeName.text)
        } else if (ts.isQualifiedName(childNode.typeName)) {
          dependencies.add(childNode.typeName.right.text)
        }
      } else if (ts.isHeritageClause(childNode)) {
        childNode.types.forEach((heritageType) => {
          if (ts.isExpressionWithTypeArguments(heritageType)) {
            if (ts.isIdentifier(heritageType.expression)) {
              dependencies.add(heritageType.expression.text)
            } else if (ts.isPropertyAccessExpression(heritageType.expression)) {
              dependencies.add(heritageType.expression.name.text)
            }
          }
        })
      } else if (ts.isPropertySignature(childNode) && childNode.type) {
        if (ts.isTypeReferenceNode(childNode.type)) {
          if (ts.isIdentifier(childNode.type.typeName)) {
            dependencies.add(childNode.type.typeName.text)
          }
        }
      } else if (ts.isPropertyDeclaration(childNode) && childNode.type) {
        if (ts.isTypeReferenceNode(childNode.type)) {
          if (ts.isIdentifier(childNode.type.typeName)) {
            dependencies.add(childNode.type.typeName.text)
          }
        }
      } else if (ts.isUnionTypeNode(childNode) || ts.isIntersectionTypeNode(childNode)) {
        childNode.types.forEach((type) => {
          if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
            dependencies.add(type.typeName.text)
          }
        })
      } else if (ts.isArrayTypeNode(childNode)) {
        if (
          ts.isTypeReferenceNode(childNode.elementType) &&
          ts.isIdentifier(childNode.elementType.typeName)
        ) {
          dependencies.add(childNode.elementType.typeName.text)
        }
      }

      ts.forEachChild(childNode, collectDependencies)
    }

    ts.forEachChild(node, collectDependencies)

    const builtInTypes = new Set(["String", "Number", "Boolean", "Array", "Promise", "Date"])
    dependencies.delete(typeName)
    builtInTypes.forEach((type) => dependencies.delete(type))

    typeDependencies.set(typeName, dependencies)
  }
}

function filterTypeDependencies(
  typeDependencies: Map<string, Set<string>>,
  sourceFile: ts.SourceFile,
): Map<string, Set<string>> {
  const filteredTypeDependencies = new Map<string, Set<string>>()

  typeDependencies.forEach((dependencies, typeName) => {
    const filteredDependencies = Array.from(dependencies).filter(
      (dep) =>
        typeDependencies.has(dep) ||
        sourceFile.statements.some(
          (stmt) =>
            (ts.isInterfaceDeclaration(stmt) ||
              ts.isTypeAliasDeclaration(stmt) ||
              ts.isClassDeclaration(stmt)) &&
            stmt.name?.text === dep,
        ),
    )
    filteredTypeDependencies.set(typeName, new Set(filteredDependencies))
  })

  return filteredTypeDependencies
}

function writeNodeToFile(
  node: ts.Node,
  typeName: string,
  typeDependencies: Map<string, Set<string>>,
  sourceFile: ts.SourceFile,
) {
  const dependencies = typeDependencies.get(typeName) || new Set<string>()
  let imports = ""

  // copy runtime/library file contents

  dependencies.forEach((dep) => {
    if (dep !== typeName) {
      imports += `import { ${dep} } from './${dep}';\n`
    }
  })

  if (imports) {
    imports += "\n"
  }

  imports += "import * as runtime from '../runtime/library.js'\n"

  imports += `
import $Types = runtime.Types // general types
import $Public = runtime.Types.Public
import $Utils = runtime.Types.Utils
import $Extensions = runtime.Types.Extensions
import $Result = runtime.Types.Result
import JsonObject = runtime.JsonObject
import JsonArray = runtime.JsonArray
import JsonValue = runtime.JsonValue
import InputJsonObject = runtime.InputJsonObject
import InputJsonArray = runtime.InputJsonArray
import InputJsonValue = runtime.InputJsonValue
\n`

  const printer = ts.createPrinter()
  let result = printer.printNode(ts.EmitHint.Unspecified, node, sourceFile)
  result = result.replace(/\bPrisma\./g, "")
  const outputFilePath = path.join(outputDir, `${typeName}.ts`)
  const fileContent = `${imports}${result}`

  // Ensure output directory exists before writing
  ensureOutputDirectory()

  // Log the type name being written for debugging
  fs.writeFileSync(outputFilePath, fileContent, "utf-8")
}

function createIndexFile(typeDependencies: Map<string, Set<string>>) {
  let indexContent = ""
  typeDependencies.forEach((_, typeName) => {
    indexContent += `export * from './${typeName}';\n`
  })

  fs.writeFileSync(indexFilePath, indexContent, "utf-8")
  console.log(
    "Successfully wrote index.d.ts with re-exports for all types, interfaces, and classes.",
  )

  const originalIndexContent = `export * from './types/index';\n`
  fs.writeFileSync(inputFilePath, originalIndexContent, "utf-8")
  console.log("Replaced original index.d.ts with export statement.")
}

async function main() {
  console.time("splitting")
  try {
    ensureOutputDirectory()

    const data = await readInputFile(inputFilePath)
    const sourceFile = ts.createSourceFile(inputFilePath, data, ts.ScriptTarget.Latest, true)
    const collectedTypeDependencies = collectTypeDependencies(sourceFile)
    const typeDependencies = filterTypeDependencies(collectedTypeDependencies, sourceFile)

    const nodes: Array<ts.Node> = []

    sourceFile.forEachChild((node) => {
      if (
        ts.isModuleDeclaration(node) &&
        node.name.text === "Prisma" &&
        node.body &&
        ts.isModuleBlock(node.body)
      ) {
        node.body.statements.forEach((statement) => {
          if (
            ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement) ||
            ts.isClassDeclaration(statement)
          ) {
            nodes.push(statement)
          }
        })
      } else if (
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isClassDeclaration(node)
      ) {
        nodes.push(node)
      }
    })

    nodes.forEach((node) => {
      const typeName = (node as ts.DeclarationStatement).name?.text
      if (typeName) {
        writeNodeToFile(node, typeName, typeDependencies, sourceFile)
      }
    })

    createIndexFile(typeDependencies)
    console.log("Splitting complete. Check the types directory for output files.")
  } catch (err) {
    console.error("Error:", err)
  }
  console.timeEnd("splitting")
}

void main()
