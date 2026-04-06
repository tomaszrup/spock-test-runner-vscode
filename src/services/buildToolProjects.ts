import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  fileExists,
  readFileIfExists,
  XML_PARENT_BLOCK_REGEX,
} from './buildToolResources';

const fsp = fs.promises;

async function resolveSearchDirectory(filePath: string): Promise<string> {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isDirectory() ? filePath : path.dirname(filePath);
  } catch {
    return path.dirname(filePath);
  }
}

export async function isGradleProject(dir: string): Promise<boolean> {
  return await fileExists(path.join(dir, 'build.gradle'))
    || await fileExists(path.join(dir, 'build.gradle.kts'));
}

export async function findGradleProjectRoot(filePath: string, workspaceRoot: string): Promise<string | null> {
  let currentDir = await resolveSearchDirectory(filePath);
  const normalizedRoot = path.resolve(workspaceRoot);

  while (true) {
    if (await isGradleProject(currentDir)) {
      return currentDir;
    }
    if (path.resolve(currentDir) === normalizedRoot) {
      return null;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export async function findGradleRootProject(projectPath: string, workspaceRoot: string): Promise<string> {
  let currentDir = projectPath;
  const normalizedRoot = path.resolve(workspaceRoot);

  while (true) {
    if (await fileExists(path.join(currentDir, 'settings.gradle'))
      || await fileExists(path.join(currentDir, 'settings.gradle.kts'))) {
      return currentDir;
    }
    if (path.resolve(currentDir) === normalizedRoot) {
      return projectPath;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return projectPath;
    }
    currentDir = parentDir;
  }
}

export function getSubprojectPrefix(rootProject: string, subprojectPath: string): string {
  const normalizedRoot = path.resolve(rootProject);
  const normalizedSub = path.resolve(subprojectPath);
  if (normalizedRoot === normalizedSub) {
    return '';
  }

  return `:${path.relative(normalizedRoot, normalizedSub).split(path.sep).join(':')}`;
}

export function parseSettingsGradleProjectDirs(content: string, rootProject: string): Map<string, string> {
  const normalizedRoot = path.resolve(rootProject);
  const projectNames: string[] = [];
  const projectDirOverrides = new Map<string, string>();

  const includeRegex = /include\s*\(?\s*(['"][^)\n]*)/g;
  let match: RegExpExecArray | null;
  while ((match = includeRegex.exec(content)) !== null) {
    const names = match[1];
    const nameRegex = /['"]([^'"]+)['"]/g;
    let nameMatch: RegExpExecArray | null;
    while ((nameMatch = nameRegex.exec(names)) !== null) {
      projectNames.push(nameMatch[1]);
    }
  }

  const projectDirRegex = /project\s*\(\s*['"][:.]?([^'"]+)['"]\s*\)\.projectDir\s*=\s*file\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = projectDirRegex.exec(content)) !== null) {
    projectDirOverrides.set(match[1], path.resolve(normalizedRoot, match[2]));
  }

  const result = new Map<string, string>();
  for (const name of projectNames) {
    const override = projectDirOverrides.get(name);
    const resolvedPath = override ?? path.resolve(normalizedRoot, ...name.split(':'));
    result.set(path.resolve(resolvedPath), `:${name}`);
  }

  return result;
}

export async function resolveSubprojectPrefix(rootProject: string, subprojectPath: string): Promise<string> {
  const normalizedRoot = path.resolve(rootProject);
  const normalizedSub = path.resolve(subprojectPath);
  if (normalizedRoot === normalizedSub) {
    return '';
  }

  const settingsPath = path.join(rootProject, 'settings.gradle');
  const settingsKtsPath = path.join(rootProject, 'settings.gradle.kts');
  const actualPath = await fileExists(settingsPath) ? settingsPath : settingsKtsPath;
  const content = await readFileIfExists(actualPath);
  if (!content) {
    return getSubprojectPrefix(rootProject, subprojectPath);
  }

  return parseSettingsGradleProjectDirs(content, rootProject).get(normalizedSub)
    ?? getSubprojectPrefix(rootProject, subprojectPath);
}

export async function hasGradleWrapper(workspacePath: string, workspaceRoot?: string): Promise<boolean> {
  let currentDir = workspacePath;
  const boundary = workspaceRoot ? path.resolve(workspaceRoot) : undefined;

  while (true) {
    if (await fileExists(path.join(currentDir, 'gradlew'))
      || await fileExists(path.join(currentDir, 'gradlew.bat'))) {
      return true;
    }
    if (boundary && path.resolve(currentDir) === boundary) {
      return false;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return false;
    }
    currentDir = parentDir;
  }
}

export async function isMavenProject(dir: string): Promise<boolean> {
  return await fileExists(path.join(dir, 'pom.xml'));
}

export async function findMavenProjectRoot(filePath: string, workspaceRoot: string): Promise<string | null> {
  let currentDir = await resolveSearchDirectory(filePath);
  const normalizedRoot = path.resolve(workspaceRoot);

  while (true) {
    if (await isMavenProject(currentDir)) {
      return currentDir;
    }
    if (path.resolve(currentDir) === normalizedRoot) {
      return null;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export async function findMavenRootProject(projectPath: string, workspaceRoot: string): Promise<string> {
  let currentDir = projectPath;
  let bestCandidate = projectPath;
  const normalizedRoot = path.resolve(workspaceRoot);

  while (true) {
    if (await isMavenProject(currentDir)) {
      try {
        const pomContent = await fsp.readFile(path.join(currentDir, 'pom.xml'), 'utf8');
        if (/<modules\s*>/.test(pomContent)) {
          bestCandidate = currentDir;
        }
      } catch {
        // Ignore read errors and keep scanning upward.
      }
    }
    if (path.resolve(currentDir) === normalizedRoot) {
      return bestCandidate;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return bestCandidate;
    }
    currentDir = parentDir;
  }
}

export function getMavenModuleName(rootProject: string, submodulePath: string): string {
  const normalizedRoot = path.resolve(rootProject);
  const normalizedSub = path.resolve(submodulePath);
  if (normalizedRoot === normalizedSub) {
    return '';
  }
  return path.relative(normalizedRoot, normalizedSub).split(path.sep).join('/');
}

export async function hasMavenWrapper(workspacePath: string, workspaceRoot?: string): Promise<boolean> {
  let currentDir = workspacePath;
  const boundary = workspaceRoot ? path.resolve(workspaceRoot) : undefined;

  while (true) {
    if (await fileExists(path.join(currentDir, 'mvnw'))
      || await fileExists(path.join(currentDir, 'mvnw.cmd'))) {
      return true;
    }
    if (boundary && path.resolve(currentDir) === boundary) {
      return false;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return false;
    }
    currentDir = parentDir;
  }
}

export async function getProjectName(workspacePath: string): Promise<string> {
  const settingsPath = path.join(workspacePath, 'settings.gradle');
  const settingsKtsPath = path.join(workspacePath, 'settings.gradle.kts');
  const actualSettingsPath = await fileExists(settingsPath) ? settingsPath : settingsKtsPath;
  const settingsContent = await readFileIfExists(actualSettingsPath);
  const settingsName = /rootProject\.name\s*=\s*['"]([^'"]+)['"]/.exec(settingsContent ?? '')?.[1];
  if (settingsName) {
    return settingsName;
  }

  const gradlePath = path.join(workspacePath, 'build.gradle');
  const gradleKtsPath = path.join(workspacePath, 'build.gradle.kts');
  const actualGradlePath = await fileExists(gradlePath) ? gradlePath : gradleKtsPath;
  const gradleContent = await readFileIfExists(actualGradlePath);
  const rootProjectName = /rootProject\.name\s*=\s*['"]([^'"]+)['"]/.exec(gradleContent ?? '')?.[1];
  if (rootProjectName) {
    return rootProjectName;
  }
  const gradleName = /name\s*=\s*['"]([^'"]+)['"]/.exec(gradleContent ?? '')?.[1];
  if (gradleName) {
    return gradleName;
  }

  const pomContent = await readFileIfExists(path.join(workspacePath, 'pom.xml'));
  if (pomContent) {
    const withoutParent = pomContent.replaceAll(XML_PARENT_BLOCK_REGEX, '');
    const pomName = /<name>([^<]+)<\/name>/.exec(withoutParent)?.[1]?.trim();
    if (pomName) {
      return pomName;
    }
    const artifactId = /<artifactId>([^<]+)<\/artifactId>/.exec(withoutParent)?.[1]?.trim();
    if (artifactId) {
      return artifactId;
    }
  }

  return path.basename(workspacePath);
}