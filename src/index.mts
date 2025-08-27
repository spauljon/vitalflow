import {END, MemorySaver, START, StateGraph} from "@langchain/langgraph";
import {intakeNode} from "./intakeNode.mjs";
import {State} from "./state.mjs";
import {dataAgent, FHIR_MCP_URL} from "./dataAgent.mjs";
import {makeSummarizerNode} from "./summarizer.mjs";
import {makePlannerNode} from "./plannerAgent.mjs";
import {getMcpClient} from "./mcpSession.mjs";
import {makeTrendNode} from "./trend.mjs";

const planner =
  makePlannerNode<typeof State.State>({model: process.env.PLANNER_MODEL});

const trendWithFetch = makeTrendNode({
  fhirClient: getMcpClient("trend-thread", FHIR_MCP_URL),
  preferExistingItems: true,
  defaultWindowDays: 30,
  frequency: "auto",
  maxItems: 500
});

const graph = new StateGraph(State)
  .addNode("intake", intakeNode)
  .addNode("planner", planner)
  .addNode("data_agent", dataAgent)
  .addNode("trend", trendWithFetch)
  .addNode("summarizer", makeSummarizerNode(/* call the factory! */))

  .addEdge(START, "intake")
  .addEdge("intake", "planner")

  .addConditionalEdges("planner", (s) => {
    if (/trend/i.test(s.query)) {
      return "trend";
    }

    if (s.route === "fetch" || s.route === "metrics") {
      return "data_agent";
    }

    return "summarizer";
  })

  .addConditionalEdges("data_agent", (s) => (s.route === "metrics" ? "summarizer" : "trend"))

  .addEdge("trend", "summarizer")
  .addEdge("summarizer", END);

const stateGraph = graph.compile({checkpointer: new MemorySaver()});

// --- quick smoke test ---
(async () => {
  const out = await stateGraph.invoke(
    {
      query: "patient test-patient-0003 trend for blood pressure readings since" +
        " 2025-01-01",
      params: {}, // optional initial params
    },
    {configurable: {thread_id: "demo-thread-1"}} // enables checkpointing per thread
  );
  console.log("SUMMARY:\n", out.summary);
})();

