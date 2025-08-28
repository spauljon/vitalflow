import {startStdio} from "./transport/stdio.mjs";
import {server} from "./server.mjs";
import {writeFileSync} from "node:fs";
import {stateGraph} from "./graph.mjs";

function isSmokeTest(): boolean {
  return process.env['SMOKE_TEST']?.toLowerCase() === 'true';
}

if (isSmokeTest()) {
// --- quick smoke test ---
  (async () => {
    const out = await stateGraph.invoke(
      {
        query: "patient test-patient-0003 trend analysis of bp readings since 2025-01-01",
        params: {}, // optional initial params
      },
      {configurable: {thread_id: "demo-thread-1"}} // enables checkpointing per thread
    );

    console.log("SUMMARY:\n", out.summary);

    // also write to a file (overwrite each run)
    writeFileSync("smoketest-output.md", out.summary ?? "", "utf8");

    console.log("Wrote output to smoketest-output.md");
  })();
} else {
  startStdio(server);
}
