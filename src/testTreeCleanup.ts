import * as vscode from 'vscode';

export interface TestTreeCleanupContext {
  controller: vscode.TestController;
  logger: vscode.LogOutputChannel;
  projectItems: Map<string, vscode.TestItem>;
  subProjectItems: Map<string, vscode.TestItem>;
  packageItems: Map<string, vscode.TestItem>;
}

export function removeEmptyFile(context: TestTreeCleanupContext, file: vscode.TestItem): void {
  context.logger.debug(`File ${file.uri?.fsPath} - Removing from tree (no runnable tests)`);
  removeEmptyPackages(context, file.id);
  removeEmptySubProjects(context, file.id);
  removeEmptyProjects(context, file.id, 'Project');
  context.controller.items.delete(file.id);
}

function removeEmptyPackages(context: TestTreeCleanupContext, fileId: string): void {
  for (const [packageKey, packageItem] of context.packageItems) {
    packageItem.children.delete(fileId);
    if (packageItem.children.size !== 0) {
      continue;
    }
    removePackageFromSubProjects(context, packageItem.id);
    removePackageFromProjects(context, packageItem.id);
    context.packageItems.delete(packageKey);
    context.logger.debug(`Package ${packageItem.label} - Removed (empty)`);
  }
}

function removePackageFromSubProjects(context: TestTreeCleanupContext, packageId: string): void {
  for (const [subPath, subItem] of context.subProjectItems) {
    subItem.children.delete(packageId);
    if (subItem.children.size === 0) {
      for (const projectItem of context.projectItems.values()) {
        projectItem.children.delete(subItem.id);
      }
      context.subProjectItems.delete(subPath);
      context.logger.debug(`Subproject ${subItem.label} - Removed (empty)`);
    }
  }
}

function removePackageFromProjects(context: TestTreeCleanupContext, packageId: string): void {
  for (const [projectRoot, projectItem] of context.projectItems) {
    projectItem.children.delete(packageId);
    if (projectItem.children.size === 0) {
      context.controller.items.delete(projectItem.id);
      context.projectItems.delete(projectRoot);
      context.logger.debug(`Root project ${projectItem.label} - Removed (empty)`);
    }
  }
}

function removeEmptySubProjects(context: TestTreeCleanupContext, fileId: string): void {
  for (const [subPath, subItem] of context.subProjectItems) {
    subItem.children.delete(fileId);
    if (subItem.children.size === 0) {
      for (const [rootPath, projectItem] of context.projectItems) {
        projectItem.children.delete(subItem.id);
        if (projectItem.children.size === 0) {
          context.controller.items.delete(projectItem.id);
          context.projectItems.delete(rootPath);
          context.logger.debug(`Root project ${projectItem.label} - Removed (empty)`);
        }
      }
      context.subProjectItems.delete(subPath);
      context.logger.debug(`Subproject ${subItem.label} - Removed (empty)`);
    }
  }
}

function removeEmptyProjects(context: TestTreeCleanupContext, fileId: string, label: string): void {
  for (const [projectRoot, projectItem] of context.projectItems) {
    projectItem.children.delete(fileId);
    if (projectItem.children.size === 0) {
      context.controller.items.delete(projectItem.id);
      context.projectItems.delete(projectRoot);
      context.logger.debug(`${label} ${projectItem.label} - Removed (no files with tests)`);
    }
  }
}