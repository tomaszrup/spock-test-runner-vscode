import * as path from 'node:path';
import * as vscode from 'vscode';
import { IBuildToolService } from './services/BuildToolService';
import { TestData } from './types';
import { RUNNABLE_TAG } from './testTreeTags';

export interface TestTreeNodeContext {
  controller: vscode.TestController;
  logger: vscode.LogOutputChannel;
  buildToolService: IBuildToolService;
  testData: WeakMap<vscode.TestItem, TestData>;
  projectItems: Map<string, vscode.TestItem>;
  subProjectItems: Map<string, vscode.TestItem>;
  packageItems: Map<string, vscode.TestItem>;
}

export async function getOrCreateRootProjectNode(context: TestTreeNodeContext, rootProjectPath: string): Promise<vscode.TestItem> {
  const existing = context.projectItems.get(rootProjectPath);
  if (existing) {
    return existing;
  }

  const projectName = await context.buildToolService.getProjectName(rootProjectPath);
  const projectItem = context.controller.createTestItem(
    `project:${rootProjectPath}`,
    projectName,
    vscode.Uri.file(rootProjectPath),
  );
  projectItem.canResolveChildren = true;
  projectItem.tags = [RUNNABLE_TAG];
  context.testData.set(projectItem, { type: 'project' });
  context.controller.items.add(projectItem);
  context.projectItems.set(rootProjectPath, projectItem);
  context.logger.appendLine(`TestTreeManager: Created root project node: ${projectName} (${rootProjectPath})`);
  return projectItem;
}

export async function getOrCreateSubProjectNode(
  context: TestTreeNodeContext,
  subProjectPath: string,
  rootProjectPath: string,
): Promise<vscode.TestItem> {
  const existing = context.subProjectItems.get(subProjectPath);
  if (existing) {
    return existing;
  }

  const subName = await context.buildToolService.getProjectName(subProjectPath);
  const subItem = context.controller.createTestItem(
    `subproject:${subProjectPath}`,
    subName,
    vscode.Uri.file(subProjectPath),
  );
  subItem.canResolveChildren = true;
  subItem.tags = [RUNNABLE_TAG];
  context.testData.set(subItem, { type: 'subproject' });

  const rootNode = await getOrCreateRootProjectNode(context, rootProjectPath);
  rootNode.children.add(subItem);
  context.subProjectItems.set(subProjectPath, subItem);
  context.logger.appendLine(`TestTreeManager: Created subproject node: ${subName} under ${rootNode.label} (${subProjectPath})`);
  return subItem;
}

export async function getOrCreateFile(context: TestTreeNodeContext, uri: vscode.Uri): Promise<vscode.TestItem> { // NOSONAR
  const existing = context.controller.items.get(uri.toString());
  if (existing) {
    return existing;
  }

  for (const projectItem of context.projectItems.values()) {
    const existingInProject = projectItem.children.get(uri.toString());
    if (existingInProject) {
      return existingInProject;
    }
  }
  for (const subItem of context.subProjectItems.values()) {
    const existingInSub = subItem.children.get(uri.toString());
    if (existingInSub) {
      return existingInSub;
    }
  }
  for (const pkgItem of context.packageItems.values()) {
    const existingInPackage = pkgItem.children.get(uri.toString());
    if (existingInPackage) {
      return existingInPackage;
    }
  }

  const file = context.controller.createTestItem(uri.toString(), path.basename(uri.fsPath), uri);
  file.canResolveChildren = true;
  file.tags = [];
  context.testData.set(file, { type: 'file' });

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    context.controller.items.add(file);
    return file;
  }

  const projectRoot = await context.buildToolService.findProjectRoot(uri.fsPath, workspaceFolder.uri.fsPath);
  if (!projectRoot) {
    context.controller.items.add(file);
    return file;
  }

  const rootProject = await context.buildToolService.findRootProject(projectRoot, workspaceFolder.uri.fsPath);
  const isRootProject = path.resolve(projectRoot) === path.resolve(rootProject);
  const parentNode = isRootProject
    ? await getOrCreateRootProjectNode(context, rootProject)
    : await getOrCreateSubProjectNode(context, projectRoot, rootProject);
  const parentPath = isRootProject ? rootProject : projectRoot;

  const packageName = extractPackageName(uri.fsPath, projectRoot);
  if (packageName) {
    const packageNode = getOrCreatePackageNode(context, packageName, parentNode, parentPath);
    packageNode.children.add(file);
  } else {
    parentNode.children.add(file);
  }

  return file;
}

export function extractPackageName(filePath: string, projectRoot: string): string {
  const relativePath = path.relative(projectRoot, filePath).replaceAll('\\', '/');
  const sourceRootPattern = /^(.*?src\/[^/]+\/(?:groovy|java|kotlin|scala))\//;
  const match = sourceRootPattern.exec(relativePath);
  if (!match) {
    return '';
  }

  const afterSourceRoot = relativePath.substring(match[1].length + 1);
  const directory = afterSourceRoot.substring(0, afterSourceRoot.lastIndexOf('/'));
  return directory ? directory.replaceAll('/', '.') : '';
}

export function getOrCreatePackageNode(
  context: TestTreeNodeContext,
  packageName: string,
  parentNode: vscode.TestItem,
  parentPath: string,
): vscode.TestItem {
  const key = `${parentPath}:${packageName}`;
  const existing = context.packageItems.get(key);
  if (existing) {
    return existing;
  }

  const packageItem = context.controller.createTestItem(`package:${key}`, packageName);
  packageItem.canResolveChildren = true;
  packageItem.tags = [RUNNABLE_TAG];
  context.testData.set(packageItem, { type: 'package' });
  parentNode.children.add(packageItem);
  context.packageItems.set(key, packageItem);
  context.logger.appendLine(`TestTreeManager: Created package node: ${packageName} under ${parentNode.label}`);
  return packageItem;
}