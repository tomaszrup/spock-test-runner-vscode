# Groovy 5 Sample Project

This sample project demonstrates a Java service tested by Spock specs that use Groovy 5 language/library features.

## Structure

- `src/main/java/com/example/OrderPricingService.java` - sample Java service
- `src/test/groovy/com/example/Groovy5FeatureSpec.groovy` - Spock tests showcasing Groovy 5

## Groovy 5 features shown

- Logical implication operator: `==>`
- Java pattern matching syntax for `instanceof` (`instanceof String s`)
- Underscore placeholders in multi-assignment and closure parameters
- Index variable in `for-in` loops (`for (int idx, var value in list)`)
- New collection extension methods (`zipAll`, `repeat`, `injectAll`)

## Run tests

From this directory:

```bash
gradle test
```

or, if Gradle wrapper is available in your environment:

```bash
./gradlew test
```
