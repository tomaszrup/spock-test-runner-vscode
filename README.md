![code status: vibed](https://img.shields.io/badge/code_status-Vibed-green)
# Spock Test Runner for VS Code

A VS Code extension that provides comprehensive test support for the [Spock testing framework](https://spockframework.org/) in Java/Groovy projects. It integrates with VS Code's Test API to offer seamless test discovery, execution, and debugging capabilities for Spock tests.

**Version**: 0.0.5  
**Author**: Tomasz Rup  
**Original Author**: [Lukas Zaruba](https://github.com/LZaruba)

> This extension is a fork of [Lukas Zaruba's spock-test-runner-vscode](https://github.com/LZaruba/spock-test-runner-vscode), which was itself inspired by [Daniel Micah's spock-test-runner](https://github.com/donnffd/spock-test-runner). It focuses exclusively on VS Code's Test API integration rather than CodeLens functionality.

## Features

- **Test Discovery** — Automatically discovers Spock test classes and feature methods in your workspace
- **Test Execution** — Run individual tests, test classes, or all tests through VS Code's Test Explorer
- **Debug Support** — Debug Spock tests with full breakpoint support and variable inspection
- **Parameterized Tests** — Full support for data-driven tests with `where` blocks, including individual iteration results
- **Code Coverage** — JaCoCo-based coverage via a Gradle init script, with line-level results in VS Code's Coverage panel
- **Gradle Integration** — Works with Gradle projects, including multi-module builds (uses init scripts to force test re-execution)
- **Maven Integration** — Works with Maven projects, including multi-module builds (uses Surefire for test execution and result parsing)
- **Groovy Language Support** — Contributes Groovy language configuration (brackets, comments, auto-closing pairs)
- **Real-time Updates** — Automatically refreshes the test tree when files change
- **Error Reporting** — Detailed error messages with file locations for failed tests
- **Inline Diff View** *(Preview)* — Failed assertions can show expected/actual values in VS Code's rich diff view (opt-in via `showDiffView` setting)
- **Output Streaming** — Real-time test output in VS Code's Test Results panel

## Requirements

- VS Code 1.85.0 or higher
- Java 11 or higher
- **Gradle** or **Maven** build tool
- Spock framework in your project

### Maven-specific Requirements

The extension uses Maven Surefire to run Spock tests. Your project must have **maven-surefire-plugin** configured with explicit `<include>` patterns for Groovy specs:

```xml
<plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-surefire-plugin</artifactId>
    <version>3.5.2</version>
    <configuration>
        <includes>
            <include>**/*Spec.java</include>
            <include>**/*Test.java</include>
        </includes>
    </configuration>
</plugin>
```

> **Important for `pom`-packaged parent projects:** Maven's `pom` lifecycle does not bind `surefire:test` by default. If you have tests in a `pom`-packaged module, you must add an explicit `<execution>` block that binds surefire to the `test` phase:
>
> ```xml
> <executions>
>     <execution>
>         <id>default-test</id>
>         <phase>test</phase>
>         <goals>
>             <goal>test</goal>
>         </goals>
>     </execution>
> </executions>
> ```
>
> Without this, tests will compile but never execute, and Maven will report `BUILD SUCCESS` with zero tests run.

### Recommended VS Code Extensions

The workspace includes recommended extensions in `.vscode/extensions.json`:

- [Language Support for Java](https://marketplace.visualstudio.com/items?itemName=redhat.java)
- [Debugger for Java](https://marketplace.visualstudio.com/items?itemName=vscjava.vscode-java-debug)
- [Test Runner for Java](https://marketplace.visualstudio.com/items?itemName=vscjava.vscode-java-test)
- [Gradle for Java](https://marketplace.visualstudio.com/items?itemName=vscjava.vscode-gradle)

## Installation

### From Source

```bash
git clone https://github.com/TomaszRup/spock-test-runner-vscode.git
cd spock-test-runner-vscode
npm install
npm run compile
```

Then press **F5** in VS Code to launch an Extension Development Host with the extension loaded.

Alternatively, use the convenience script:

```bash
./run-vscode.sh
```

This script compiles the extension and opens VS Code with the sample project loaded.

## Usage

### Test Discovery

The extension automatically discovers Spock tests organized in the Test Explorer:

```
Workspace
  └── File (.groovy)
       └── Test Class (extends Specification)
            └── Feature Methods
                 └── Iterations (for data-driven tests)
```

### Commands

| Command | Title | Description |
|---|---|---|
| `spock-test-runner-vscode.runTest` | Run Spock Test | Run all tests in the current file (also in editor context menu) |
| `spock-test-runner-vscode.runSpecificTest` | Run This Test | Run a single test method |
| `spock-test-runner-vscode.debugSpecificTest` | Debug This Test | Debug a single test method |
| `spock-test-runner.reloadTests` | Reload Spock Tests | Re-discover all Spock tests in the workspace |

### Running Tests

| Method | How |
|---|---|
| Run all tests | Click ▶ in the Test Explorer toolbar |
| Run a single test | Click ▶ next to the test name |
| Run with coverage | Click the coverage icon in the Test Explorer toolbar |
| Command Palette | `Ctrl+Shift+P` → *Run Spock Test* |
| Context menu | Right-click a `.groovy` file → *Run Spock Test* |

### Debugging Tests

1. Set breakpoints by clicking the gutter in your test files
2. Click the debug icon next to a test or class in the Test Explorer
3. The extension automatically attaches to the JVM on port **5005**

## Configuration

### Build Tool Detection

The extension automatically detects your build tool by looking for project files in the workspace, searching upward from test files to find the nearest project root:

| Build Tool | Detected by | Multi-module support |
|---|---|---|
| Gradle | `build.gradle` or `build.gradle.kts` | Yes — via `settings.gradle` and subproject prefixes |
| Maven | `pom.xml` | Yes — via `<modules>` and `-pl` flag |

Gradle is checked first. If both `build.gradle` and `pom.xml` exist, Gradle takes precedence.

### Force Test Execution

- **Gradle**: Up-to-date check is bypassed via an init script (`resources/force-tests.init.gradle`) so tests always run, even if sources haven't changed.
- **Maven**: Surefire runs tests on every invocation by default (no caching mechanism to bypass).

### Code Coverage

- **Gradle**: When run with the Coverage profile, the extension injects JaCoCo via a Gradle init script (`resources/coverage.init.gradle`). After the test run, JaCoCo XML reports are parsed by `CoverageService` to provide line-level coverage data in VS Code's Coverage panel.
- **Maven**: Coverage uses inline JaCoCo Maven plugin goals (`org.jacoco:jacoco-maven-plugin:prepare-agent` and `report`) without requiring any `pom.xml` configuration changes.

### Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `spockTestRunner.debugPort` | `number` | `5005` | Port number used by the JVM debug agent (JDWP) |
| `spockTestRunner.testTimeout` | `number` | `300` | Maximum time (in seconds) to wait for a single test execution |
| `spockTestRunner.debugConnectionTimeout` | `number` | `60` | Maximum time (in seconds) to wait for the JVM debug port |
| `spockTestRunner.debugRetries` | `number` | `3` | Number of times to retry attaching the debugger |
| `spockTestRunner.additionalGradleArgs` | `string[]` | `[]` | Additional CLI arguments passed to every Gradle invocation |
| `spockTestRunner.additionalMavenArgs` | `string[]` | `[]` | Additional CLI arguments passed to every Maven invocation |
| `spockTestRunner.logLevel` | `string` | `"info"` | Output channel verbosity (`off`, `error`, `info`, `debug`) |
| `spockTestRunner.showDiffView` | `boolean` | `false` | *(Preview)* Show expected/actual values in VS Code's inline diff view for failed assertions |

## Project Structure

```
├── src/
│   ├── extension.ts                 # Extension entry point & command registration
│   ├── testController.ts            # VS Code Test Controller (discovery, run, debug, coverage)
│   ├── types.ts                     # Shared types (BuildTool enum, annotations, etc.)
│   ├── __mocks__/
│   │   └── vscode.ts               # VS Code API mock for unit tests
│   └── services/
│       ├── BuildToolService.ts      # Build tool detection (Gradle/Maven) & command building
│       ├── ConfigurationService.ts  # Centralised settings accessor
│       ├── CoverageService.ts       # JaCoCo XML report parsing & VS Code coverage API
│       ├── DebugService.ts          # Debug session management (port 5005)
│       ├── TestDiscoveryService.ts  # Groovy file parsing & test discovery
│       ├── TestExecutionService.ts  # Process spawning & output handling
│       └── TestResultParser.ts      # Console output & Surefire/Gradle XML report parsing
├── images/
│   └── spock.png                    # Extension icon
├── resources/
│   ├── coverage.init.gradle         # Gradle init script to inject JaCoCo for coverage
│   └── force-tests.init.gradle      # Gradle init script to bypass up-to-date checks
├── sample-project/                  # Sample Gradle + Spock project (Java 21, Spock 2.4-M1)
│   └── sub-module/                  # Gradle sub-module for multi-module testing
├── sample-maven-project/            # Sample Maven + Spock project (Java 21, Spock 2.4-M1)
│   └── sub-module/                  # Maven sub-module for multi-module testing
├── .vscode/
│   ├── launch.json                  # Run/debug extension configurations
│   ├── tasks.json                   # Build tasks
│   └── extensions.json              # Recommended extensions
├── package.json                     # Extension manifest
├── tsconfig.json                    # TypeScript configuration
├── vitest.config.ts                 # Vitest test configuration
├── .eslintrc.json                   # ESLint configuration
├── language-configuration.json      # Groovy language configuration
├── .vscodeignore                    # Files excluded from VSIX package
├── run-vscode.sh                    # Convenience script to launch dev instance
├── CHANGELOG.md                     # Version history
├── LICENSE                          # Apache License 2.0
└── README.md
```

## Sample Projects

Two sample projects are included:

- **`sample-project/`** — Gradle-based project using Java 21, Groovy 4.0.15, and Spock 2.4-M1. Includes a `sub-module/` Gradle sub-project to exercise multi-module test discovery.
- **`sample-maven-project/`** — Maven-based project with the same dependencies and test suites. Uses a multi-module layout with `pom` parent packaging and a `sub-module/`. Demonstrates Maven Surefire integration including the required `<execution>` binding for `pom`-packaged modules.

### Test Specs

| Spec | Description |
|---|---|
| `CalculatorSpec` | Basic arithmetic operations (add, subtract, multiply, divide, division by zero) |
| `BowlingGameSpec` | Bowling score calculation with various data-table separator styles |
| `FrameSpec` | Frame-level logic (rolls, strikes, spares, last-frame rules, validation) |
| `DataDrivenSpec` | Data-driven patterns (pipes, double-pipes, semicolons, data pipes, `@Unroll`) |
| `ComplexDataSpec` | Complex data structures (lists, maps, nested structures) with `@Unroll` |
| `UserServiceSpec` | User CRUD operations with valid/invalid data |
| `NestedClassSpec` | Spec with nested assertions and where-blocks |
| `AnnotationSpec` | Demonstrates Spock annotations (`@Ignore`, `@PendingFeature`, `@IgnoreIf`, `@Requires`, `@Timeout`, etc.) |
| `DeliberateFailureSpec` | Comprehensive suite of deliberately failing tests (assertions, data-driven, timeouts, mocks, diffs) |
| `IgnoredClassSpec` | Entirely `@Ignore`-annotated spec (appears in tree but isn't run) |
| `InheritedSpec` | Extends `AbstractSpec` to verify discovery handles base-class inheritance |
| `StepwiseSpec` | `@Stepwise`-annotated spec where test order matters |
| `AbstractSpec` | Abstract `Specification` subclass (not directly runnable — tests discovery edge case) |
| `EmptySpec` | Empty spec with no methods (edge case for discovery) |
| `MalformedSpec` | Minimal where-blocks, complex Groovy syntax, edge-case data (parser robustness) |

### Sub-module Specs (`sub-module/`)

| Spec | Description |
|---|---|
| `MathHelperSpec` | Factorial, negative-input exceptions, and prime detection |
| `StringHelperSpec` | String reversal, palindrome detection, and capitalization |
| `IgnoredSubModuleSpec` | `@Ignore`-annotated spec in a sub-module |
| `StepwiseSubModuleSpec` | `@Stepwise` spec with sequential counter operations |

### Support Classes

- `Person.groovy` — Simple POJO with `name` and `age` (test source)
- `Calculator.java` — Basic calculator (test source)
- `TestTrait.groovy` — Groovy trait providing a helper method (test source)
- `User.java`, `UserService.java` — In-memory user model and service (test source)
- `BowlingGame.java`, `Frame.java`, `BowlingException.java` — Bowling game engine (`src/main/java`)

To try it out:

1. Open the `sample-project` folder in VS Code
2. Install the extension (or press F5 from the root project)
3. Open the Test Explorer — tests are discovered automatically
4. Run or debug any test

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode (recompile on changes)
npm run watch

# Run unit tests (Vitest)
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Lint
npm run lint

# Package as VSIX
npm run package
```

### Launch Configurations

The `.vscode/launch.json` provides:

- **Run Extension** — Launches an Extension Development Host with the extension loaded

## Troubleshooting

| Problem | Solution |
|---|---|
| Tests not discovered | Ensure test classes extend `Specification` and your build tool is configured correctly |
| Debug not working | Install the Java Extension Pack; verify port 5005 is free |
| Gradle errors | Ensure `gradlew` (or `gradle`) is on your PATH and build files are valid |
| Maven tests not running | Verify `maven-surefire-plugin` is configured with `<include>` patterns for `*Spec.java`. For `pom`-packaged modules, add an explicit `<execution>` binding to the `test` phase (see [Maven requirements](#maven-specific-requirements)) |
| Maven BUILD SUCCESS but 0 tests | The Surefire plugin is not bound to the lifecycle — see the Maven requirements section above |
| Stale results | Use the *Reload Spock Tests* command from the Command Palette |

Check the **Output** panel → **Spock Test Runner** for detailed logs.

## Contributing

Contributions are welcome! Please open an issue first to discuss major changes, then submit a Pull Request.

## License

This project is licensed under the **Apache License 2.0** — see the [LICENSE](LICENSE) file for details.

```
Copyright 2025 Lukas Zaruba
Copyright 2026 Tomasz Rup
```

## Acknowledgments

- **[Lukas Zaruba](https://github.com/LZaruba)** — Original author of this extension
- **[Daniel Micah](https://github.com/donnffd/spock-test-runner)** — Inspiration for the original project
- **[Spock Framework](https://spockframework.org/)** — The testing framework this extension supports
- **[VS Code Test API](https://code.visualstudio.com/api/extension-guides/testing)** — The testing API used by this extension
- **[Gradle](https://gradle.org/)** — Build tool integration
- **[Maven](https://maven.apache.org/)** / **[Surefire](https://maven.apache.org/surefire/maven-surefire-plugin/)** — Build tool and test execution integration
