import { defineConfig } from "vitest/config";

// The test files share one database and work-orders.test.ts TRUNCATEs
// task_state_history in afterAll: running files in parallel would wipe the
// history other files are reading. Files run one after another.
export default defineConfig({
  test: { fileParallelism: false }
});
