import * as vscode from 'vscode';
import { ClassDeclaration } from './services/testDiscoveryShared';
import { ITestDiscoveryService } from './services/TestDiscoveryService';
import { SpockAnnotation, TestData } from './types';
import {
  buildAnnotationTags,
  buildIgnoredTags,
  formatAnnotationDescription,
  RUNNABLE_TAG,
} from './testTreeTags';
import { removeEmptyFile } from './testTreeCleanup';

type ParsedClass = ReturnType<ITestDiscoveryService['parseTestsInFile']>[number];
type ParsedMethod = ParsedClass['methods'][number];

export interface TestTreeParsingContext {
  controller: vscode.TestController;
  logger: vscode.LogOutputChannel;
  testDiscoveryService: ITestDiscoveryService;
  testData: WeakMap<vscode.TestItem, TestData>;
  iterationItems: Map<string, vscode.TestItem[]>;
  projectItems: Map<string, vscode.TestItem>;
  subProjectItems: Map<string, vscode.TestItem>;
  packageItems: Map<string, vscode.TestItem>;
}

export function parseTestsInFile(
  context: TestTreeParsingContext,
  file: vscode.TestItem,
  content: string,
  knownSpecBaseClasses?: Set<string>,
): void { // NOSONAR
  if (!file.uri) {
    return;
  }

  context.logger.appendLine(`TestTreeManager: Parsing tests in file: ${file.uri.fsPath}`);
  file.children.replace([]);

  const summary = populateFileWithTests(context, file, content, knownSpecBaseClasses);

  if (summary.hasRunnableClasses) {
    file.tags = [RUNNABLE_TAG];
    context.logger.debug(`File ${file.uri.fsPath} - ASSIGNED runnable tag (has runnable classes)`);
  } else if (summary.hasAnyClasses) {
    file.tags = [];
    context.logger.debug(`File ${file.uri.fsPath} - Kept in tree (has classes, none runnable)`);
  } else {
    removeEmptyFile(context, file);
    return;
  }

  context.logger.debug(`File ${file.uri.fsPath} - Final tags: ${JSON.stringify(file.tags.map(tag => tag.id))}`);
  context.logger.appendLine(`TestTreeManager: Parsed ${summary.testCount} tests in file: ${file.uri.fsPath}`);
}

function populateFileWithTests(
  context: TestTreeParsingContext,
  file: vscode.TestItem,
  content: string,
  knownSpecBaseClasses?: Set<string>,
): { testCount: number; hasRunnableClasses: boolean; hasAnyClasses: boolean } {
  const testClasses = context.testDiscoveryService.parseTestsInFile(content, knownSpecBaseClasses);
  const fileUri = file.uri;
  if (!fileUri) {
    return { testCount: 0, hasRunnableClasses: false, hasAnyClasses: false };
  }
  const packageName = inferPackageNameFromFile(fileUri.fsPath);
  const summary = { testCount: 0, hasRunnableClasses: false, hasAnyClasses: false };

  for (const testClass of testClasses) {
    const classState = addClassToFile(context, fileUri, file, testClass, packageName);
    if (!classState) {
      continue;
    }

    summary.hasAnyClasses = true;
    summary.hasRunnableClasses = summary.hasRunnableClasses || !classState.classIgnored;
    summary.testCount += addMethodsToClass(context, classState, testClass);
  }

  return summary;
}

function addClassToFile(
  context: TestTreeParsingContext,
  fileUri: vscode.Uri,
  file: vscode.TestItem,
  testClass: ParsedClass,
  packageName: string,
): { classItem: vscode.TestItem; classFqn: string; classIgnored: boolean; classPending: boolean; classAnnotations: ParsedClass['annotations']; fileUri: vscode.Uri } | undefined {
  context.logger.appendLine(`TestTreeManager: Found test class: ${testClass.name}`);
  context.logger.debug(`Class ${testClass.name} - isAbstract: ${testClass.isAbstract}, annotations: ${JSON.stringify(testClass.annotations?.map(annotation => annotation.name))}`);
  if (testClass.isAbstract) {
    context.logger.debug(`Class ${testClass.name} - SKIPPED (abstract class)`);
    return undefined;
  }

  const classIgnored = context.testDiscoveryService.hasAnnotation(testClass.annotations, 'Ignore');
  const classStepwise = context.testDiscoveryService.hasAnnotation(testClass.annotations, 'Stepwise');
  const classPending = context.testDiscoveryService.hasAnnotation(testClass.annotations, 'PendingFeature');
  const classConditional = context.testDiscoveryService.hasAnnotation(testClass.annotations, 'IgnoreIf')
    || context.testDiscoveryService.hasAnnotation(testClass.annotations, 'Requires');
  const classLabel = getClassLabel(testClass.name, classIgnored, classStepwise);

  const classItem = context.controller.createTestItem(
    `${fileUri.toString()}#${testClass.name}`,
    classLabel,
    fileUri,
  );
  classItem.range = testClass.range;
  applyClassPresentation(classItem, testClass.annotations, classIgnored, classConditional || classStepwise);

  context.logger.debug(`Class ${testClass.name} - label: "${classLabel}", ignored: ${classIgnored}`);
  const classFqn = packageName ? `${packageName}.${testClass.name}` : testClass.name;
  context.testData.set(classItem, { type: 'class', className: testClass.name, classFqn });
  file.children.add(classItem);

  return { classItem, classFqn, classIgnored, classPending, classAnnotations: testClass.annotations, fileUri };
}

function addMethodsToClass(
  context: TestTreeParsingContext,
  classState: { classItem: vscode.TestItem; classFqn: string; classIgnored: boolean; classPending: boolean; classAnnotations: ParsedClass['annotations']; fileUri: vscode.Uri },
  testClass: ParsedClass,
): number {
  let testCount = 0;
  for (const testMethod of testClass.methods) {
    context.logger.appendLine(`TestTreeManager: Found test method: ${testMethod.name}`);
    testCount++;

    const methodState = getMethodState(context, testMethod.annotations, classState.classIgnored, classState.classPending);
    context.logger.debug(`Method ${testMethod.name} in class ${testClass.name} - ignored: ${methodState.methodIgnored}, pending: ${methodState.methodPending}`);

    if (testMethod.isDataDriven) {
      addDataDrivenMethod(context, classState, testClass.name, testMethod, methodState);
      continue;
    }

    addRegularMethod(context, classState, testClass.name, testMethod, methodState);
  }
  return testCount;
}

function getClassLabel(className: string, classIgnored: boolean, classStepwise: boolean): string {
  if (classIgnored) {
    return `${className} ⊘ Ignored`;
  }
  if (classStepwise) {
    return `${className} ⟳ Stepwise`;
  }
  return className;
}

function applyClassPresentation(
  classItem: vscode.TestItem,
  annotations: SpockAnnotation[] | undefined,
  classIgnored: boolean,
  shouldDescribe: boolean,
): void {
  if (classIgnored) {
    classItem.tags = buildIgnoredTags(annotations);
    classItem.description = formatAnnotationDescription(annotations);
    return;
  }

  classItem.tags = buildAnnotationTags(annotations);
  if (shouldDescribe) {
    classItem.description = formatAnnotationDescription(annotations);
  }
}

function getMethodState(
  context: TestTreeParsingContext,
  methodAnnotations: SpockAnnotation[] | undefined,
  classIgnored: boolean,
  classPending: boolean,
): { methodIgnored: boolean; methodPending: boolean; methodConditional: boolean } {
  const methodIgnored = classIgnored || context.testDiscoveryService.hasAnnotation(methodAnnotations, 'Ignore');
  const methodPending = classPending || context.testDiscoveryService.hasAnnotation(methodAnnotations, 'PendingFeature');
  const methodConditional = context.testDiscoveryService.hasAnnotation(methodAnnotations, 'IgnoreIf')
    || context.testDiscoveryService.hasAnnotation(methodAnnotations, 'Requires');

  return {
    methodIgnored,
    methodPending,
    methodConditional,
  };
}

function addDataDrivenMethod(
  context: TestTreeParsingContext,
  classState: { classItem: vscode.TestItem; classFqn: string; classIgnored: boolean; classPending: boolean; classAnnotations: ParsedClass['annotations']; fileUri: vscode.Uri },
  className: string,
  testMethod: ParsedMethod,
  methodState: { methodIgnored: boolean; methodPending: boolean; methodConditional: boolean },
): void {
  const parentTestItem = context.controller.createTestItem(
    `${classState.fileUri.toString()}#${className}#${testMethod.name}`,
    getMethodLabel(testMethod.name, methodState.methodIgnored, methodState.methodPending),
    classState.fileUri,
  );
  parentTestItem.range = testMethod.range;
  parentTestItem.canResolveChildren = false;
  applyMethodPresentation(parentTestItem, testMethod.annotations, classState.classAnnotations, methodState);

  context.testData.set(parentTestItem, {
    type: 'test',
    className,
    classFqn: classState.classFqn,
    testName: testMethod.name,
    isDataDriven: true,
  });
  classState.classItem.children.add(parentTestItem);

  if (testMethod.whereBlock && !methodState.methodIgnored) {
    createPreParsedIterations(context, parentTestItem, testMethod, className, classState.classFqn);
  }
}

function addRegularMethod(
  context: TestTreeParsingContext,
  classState: { classItem: vscode.TestItem; classFqn: string; classAnnotations: ParsedClass['annotations']; fileUri: vscode.Uri },
  className: string,
  testMethod: ParsedMethod,
  methodState: { methodIgnored: boolean; methodPending: boolean; methodConditional: boolean },
): void {
  const testItem = context.controller.createTestItem(
    `${classState.fileUri.toString()}#${className}#${testMethod.name}`,
    getMethodLabel(testMethod.name, methodState.methodIgnored, methodState.methodPending),
    classState.fileUri,
  );
  testItem.range = testMethod.range;
  applyMethodPresentation(testItem, testMethod.annotations, classState.classAnnotations, methodState);
  context.testData.set(testItem, {
    type: 'test',
    className,
    testName: testMethod.name,
    classFqn: classState.classFqn,
  });
  classState.classItem.children.add(testItem);
}

function getMethodLabel(methodName: string, methodIgnored: boolean, methodPending: boolean): string {
  if (methodIgnored) {
    return `${methodName} ⊘`;
  }
  if (methodPending) {
    return `${methodName} ⏳`;
  }
  return methodName;
}

function applyMethodPresentation(
  testItem: vscode.TestItem,
  methodAnnotations: SpockAnnotation[] | undefined,
  classAnnotations: SpockAnnotation[] | undefined,
  methodState: { methodIgnored: boolean; methodPending: boolean; methodConditional: boolean },
): void {
  if (methodState.methodIgnored) {
    testItem.tags = buildIgnoredTags(methodAnnotations, classAnnotations);
    testItem.description = formatAnnotationDescription(methodAnnotations);
    return;
  }

  testItem.tags = buildAnnotationTags(methodAnnotations, classAnnotations);
  if (methodState.methodPending || methodState.methodConditional) {
    testItem.description = formatAnnotationDescription(methodAnnotations);
  }
}

function inferPackageNameFromFile(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/');
  const match = /\/src\/[^/]+\/(?:groovy|java|kotlin|scala)\/(.+)\//.exec(normalized);
  if (!match?.[1]) {
    return '';
  }
  return match[1].replaceAll('/', '.');
}

export function cleanupIterationItems(context: TestTreeParsingContext, fileUri: string): void {
  const items = context.iterationItems.get(fileUri);
  if (!items) {
    return;
  }

  context.logger.appendLine(`TestTreeManager: Cleaning up ${items.length} old iteration items for ${fileUri}`);
  for (const item of items) {
    item.parent?.children.delete(item.id);
    context.controller.items.delete(item.id);
    context.testData.delete(item);
  }
  context.iterationItems.delete(fileUri);
}

function createPreParsedIterations(
  context: TestTreeParsingContext,
  parentTestItem: vscode.TestItem,
  testMethod: { name: string; whereBlock?: { parameterNames: string[]; iterationCount: number; dataRows?: string[][] } },
  className: string,
  classFqn: string,
): void {
  const whereBlock = testMethod.whereBlock;
  if (!whereBlock) {
    return;
  }

  const fileUri = parentTestItem.uri?.toString() || '';
  const newIterationItems: vscode.TestItem[] = [];
  for (let index = 0; index < whereBlock.iterationCount; index++) {
    const iterationItem = context.controller.createTestItem(
      `${parentTestItem.id}#iteration-${index}`,
      `${testMethod.name} [#${index}] ${formatIterationParams(whereBlock, index)}`,
      parentTestItem.uri,
    );
    iterationItem.range = parentTestItem.range;
    iterationItem.tags = [RUNNABLE_TAG];

    context.testData.set(iterationItem, {
      type: 'test',
      className,
      classFqn,
      testName: testMethod.name,
      isPreParsedIteration: true,
      iterationIndex: index,
    });
    parentTestItem.children.add(iterationItem);
    newIterationItems.push(iterationItem);
  }

  if (newIterationItems.length > 0) {
    context.iterationItems.set(fileUri, [
      ...(context.iterationItems.get(fileUri) || []),
      ...newIterationItems,
    ]);
    context.logger.debug(`Created ${newIterationItems.length} pre-parsed iteration items for ${testMethod.name}`);
  }
}

function formatIterationParams(
  whereBlock: { parameterNames: string[]; dataRows?: string[][] },
  index: number,
): string {
  if (!whereBlock.dataRows?.[index]) {
    return '';
  }
  return whereBlock.parameterNames
    .map((name, columnIndex) => `${name}: ${whereBlock.dataRows?.[index]?.[columnIndex]}`)
    .join(', ');
}

export function haveDeclarationsChanged(previous: ClassDeclaration[], current: ClassDeclaration[]): boolean {
  if (previous.length !== current.length) {
    return true;
  }

  for (let index = 0; index < previous.length; index++) {
    const prev = previous[index];
    const next = current[index];
    if (prev.name !== next?.name || prev.parent !== next?.parent || prev.isAbstract !== next?.isAbstract) {
      return true;
    }
  }

  return false;
}