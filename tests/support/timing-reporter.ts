import { mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import type {
  Reporter,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";

export default class TimingReporter implements Reporter {
  onStepEnd(test: TestCase, result: TestResult, step: TestStep) {
    const directory = test.parent.project()!.outputDir;
    mkdirSync(directory, { recursive: true });
    appendFileSync(
      path.join(directory, "safe-timing.jsonl"),
      JSON.stringify({
        test: test.title,
        repeat: test.repeatEachIndex,
        category: step.category,
        // Playwright titles can include fill/password arguments. Keep category,
        // source line and duration instead of echoing those values.
        file: step.location ? path.basename(step.location.file) : undefined,
        line: step.location?.line,
        duration: step.duration,
        failed: Boolean(step.error),
      }) + "\n",
      { mode: 0o600 },
    );
  }
}
