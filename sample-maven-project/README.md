# Bowling Game Sample Maven Project

This sample project demonstrates the Spock Test Runner VS Code extension with a complete bowling game implementation and comprehensive test suite, using **Maven** as the build tool.

## 🎯 Project Structure

```
sample-maven-project/
├── pom.xml                           # Parent POM (multi-module)
├── mvnw / mvnw.cmd                   # Maven wrapper scripts
├── .mvn/wrapper/                     # Maven wrapper configuration
├── src/main/java/com/example/
│   ├── BowlingGame.java              # Main bowling game logic
│   ├── Frame.java                    # Frame representation
│   └── BowlingException.java        # Custom exceptions
├── src/test/groovy/com/example/
│   ├── BowlingGameSpec.groovy        # Comprehensive Spock tests
│   ├── FrameSpec.groovy              # Frame-specific tests
│   ├── ComplexDataSpec.groovy        # Complex data-driven tests
│   ├── DataDrivenSpec.groovy         # All where block variations
│   ├── DeliberateFailureSpec.groovy  # Deliberately failing tests
│   ├── CalculatorSpec.groovy         # Calculator tests
│   ├── UserServiceSpec.groovy        # User service tests
│   ├── AnnotationSpec.groovy         # Spock annotation demos
│   ├── StepwiseSpec.groovy           # Ordered stepwise tests
│   ├── EmptySpec.groovy              # Empty test class (edge case)
│   ├── NestedClassSpec.groovy        # Nested classes (edge case)
│   ├── AbstractSpec.groovy           # Abstract test class (edge case)
│   ├── InheritedSpec.groovy          # Inherited spec (edge case)
│   ├── IgnoredClassSpec.groovy       # Ignored class (edge case)
│   ├── MalformedSpec.groovy          # Malformed syntax (edge case)
│   ├── Person.groovy                 # Person data class
│   ├── TestTrait.groovy              # Test trait
│   ├── Calculator.java               # Calculator helper class
│   ├── User.java                     # User data class
│   └── UserService.java              # User service class
├── sub-module/
│   ├── pom.xml                       # Sub-module POM
│   ├── src/main/java/com/example/submodule/
│   │   ├── MathHelper.java           # Math utilities
│   │   └── StringHelper.java         # String utilities
│   └── src/test/groovy/com/example/submodule/
│       ├── MathHelperSpec.groovy      # Math helper tests
│       ├── StringHelperSpec.groovy    # String helper tests
│       ├── StepwiseSubModuleSpec.groovy # Stepwise sub-module tests
│       └── IgnoredSubModuleSpec.groovy  # Ignored sub-module tests
└── README.md
```

## 🎮 Bowling Game Features

### Core Classes
- **BowlingGame**: Main game logic with scoring, frame management, and validation
- **Frame**: Individual frame representation with strike/spare detection
- **BowlingException**: Custom exception for bowling-specific errors

### Game Rules Implemented
- ✅ Standard 10-pin bowling rules
- ✅ Strike detection and bonus scoring
- ✅ Spare detection and bonus scoring
- ✅ Last frame special handling (3 rolls for strike/spare)
- ✅ Input validation (0-10 pins per roll)
- ✅ Game state tracking (current frame, roll, completion)

## 🧪 Test Coverage

### Where Block Variations (tested in DataDrivenSpec & BowlingGameSpec)
1. **Pipe separators** (`|`) - Standard data tables
2. **Double pipe separators** (`||`) - Input vs output separation
3. **Semicolon separators** (`;` / `;;`) - Alternative syntax
4. **Mixed separators** - Combining pipe and double pipe
5. **Single column** - Using `_` placeholder
6. **Placeholders in method name** - `#variable` substitution
7. **Complex placeholders** - Object property access
8. **Data pipes with lists** - `<<` operator with list
9. **Data pipes with maps** - Destructuring assignment
10. **Data pipes with ranges** - `<<` with Groovy range
11. **Multiple data pipes** - Several `<<` sources
12. **@Unroll annotation** - Custom unroll patterns
13. **Method parameters** - Explicit parameter types
14. **Complex data tables** - Multi-column with various types

### Extension Testing Features
- **Annotation handling**: `@Ignore`, `@PendingFeature`, `@Timeout`, `@IgnoreIf`, `@Requires`, `@IgnoreRest`, `@Stepwise`
- **Deliberate failures**: Assertion failures, exception mismatches, mock failures, soft assertions
- **Edge cases**: Empty specs, abstract specs, inherited specs, nested classes, malformed syntax
- **Multi-module**: Sub-module with independent tests

## 🔧 Build & Run

### Prerequisites
- Java 21+
- Maven 3.9+ (or use the included Maven wrapper)

### Maven Surefire Configuration

This project uses **maven-surefire-plugin** to execute Spock tests. Two configuration details are important:

1. **Include patterns** — Surefire needs explicit `<include>` patterns to find Groovy specs compiled to `.class` files:
   ```xml
   <includes>
       <include>**/*Spec.java</include>
       <include>**/*Test.java</include>
   </includes>
   ```

2. **`pom`-packaged parent modules** — The root `pom.xml` uses `<packaging>pom</packaging>`. Maven's `pom` lifecycle does **not** bind `surefire:test` automatically, so an explicit `<execution>` block is required for tests to run:
   ```xml
   <plugin>
       <groupId>org.apache.maven.plugins</groupId>
       <artifactId>maven-surefire-plugin</artifactId>
       <executions>
           <execution>
               <id>default-test</id>
               <phase>test</phase>
               <goals>
                   <goal>test</goal>
               </goals>
           </execution>
       </executions>
   </plugin>
   ```
   Without this, `mvn test` compiles the tests but never executes them, reporting `BUILD SUCCESS` with zero tests run.

   The `sub-module/` uses standard `jar` packaging and inherits surefire normally — no extra `<execution>` is needed there.

### Build
```bash
# Using Maven wrapper
./mvnw compile

# Using system Maven
mvn compile
```

### Run Tests
```bash
# Run all tests
./mvnw test

# Run specific test class
./mvnw test -pl . -Dtest="com.example.CalculatorSpec"

# Run sub-module tests
./mvnw test -pl sub-module

# Run with verbose output
./mvnw test -X
```

### Clean Build
```bash
./mvnw clean test
```

## 📊 Test Statistics
- **Root module**: ~18 spec classes with 100+ test methods
- **Sub-module**: 4 spec classes with ~20 test methods
- **Data-driven iterations**: 150+ parameterized test cases
- **Deliberate failures**: ~20 intentionally failing tests for extension validation
